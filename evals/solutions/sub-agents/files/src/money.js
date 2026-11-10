/** An amount of money as people write it, in whole cents. */
export function parseMoney(text) {
  const trimmed = text.trim();
  const negative = trimmed.startsWith('-');
  const number = trimmed.replace(/^-/, '').replace(/^[^\d]+|[^\d]+$/g, '');
  if (!/^\d([\d.,]*\d)?$/.test(number)) throw new RangeError(`Not an amount: ${text}`);
  // The last separator starts the decimals; any before it group thousands.
  const last = Math.max(number.lastIndexOf('.'), number.lastIndexOf(','));
  const decimals = last === -1 ? '' : number.slice(last + 1);
  if (decimals.length > 2) throw new RangeError(`More than two decimals: ${text}`);
  const whole = (last === -1 ? number : number.slice(0, last)).replace(/[.,]/g, '');
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return negative ? -cents : cents;
}
