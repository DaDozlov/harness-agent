import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Where a URL leads, for `web_fetch` (docs/DESIGN.md §8). An approved hostname says nothing
 * about the address behind it: a page, or a name pointing at 10.0.0.5, can lead the agent to
 * the cloud metadata service or to internal services that trust the local network.
 */

/** Never fetched: link-local (cloud metadata at 169.254.169.254) and unspecified addresses. */
const NEVER = new BlockList();
NEVER.addSubnet('169.254.0.0', 16, 'ipv4');
NEVER.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER.addSubnet('fe80::', 10, 'ipv6');
NEVER.addAddress('::', 'ipv6');

/** Loopback and private networks: fetched when the URL names them itself. */
const LOCAL = new BlockList();
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('10.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('172.16.0.0', 12, 'ipv4');
LOCAL.addSubnet('192.168.0.0', 16, 'ipv4');
LOCAL.addSubnet('100.64.0.0', 10, 'ipv4');
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addSubnet('fc00::', 7, 'ipv6');

export type AddressKind = 'never' | 'local' | 'public';

export function addressKind(address: string): AddressKind {
  // An IPv4 address written as IPv6 (::ffff:127.0.0.1) is the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const plain = mapped ?? address;
  const family = isIP(plain) === 6 ? 'ipv6' : 'ipv4';
  if (NEVER.check(plain, family)) return 'never';
  if (LOCAL.check(plain, family)) return 'local';
  return 'public';
}

async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/** A host that names a local address itself, so an approval of it shows what it reaches. */
function namesItself(host: string): boolean {
  return isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost');
}

/**
 * Why `url` may not be fetched, or undefined. `allowedByRule`: whether a rule the user wrote
 * names the host, which lets a name lead to a private address (an internal wiki).
 */
export async function addressProblem(
  url: URL,
  allowedByRule: (host: string) => boolean,
  resolve: (host: string) => Promise<string[]> = resolveAll,
): Promise<string | undefined> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return undefined; // The fetch reports a name that does not resolve.
  }
  const never = addresses.find((address) => addressKind(address) === 'never');
  if (never) {
    return (
      `${host} is ${never}, a link-local or unspecified address (where cloud metadata services ` +
      'answer): web_fetch never fetches those.'
    );
  }
  const local = addresses.find((address) => addressKind(address) === 'local');
  if (local && !namesItself(host) && !allowedByRule(host)) {
    return (
      `${host} resolves to ${local}, a loopback or private address. web_fetch fetches those only ` +
      `when the URL names the address itself (http://${local.includes(':') ? `[${local}]` : local}/…), ` +
      `or when a rule allows the host (web_fetch(${host})), so that an approval shows what it reaches.`
    );
  }
  return undefined;
}
