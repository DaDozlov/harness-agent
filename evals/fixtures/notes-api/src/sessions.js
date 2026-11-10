import { randomUUID } from 'node:crypto';
import { config } from './config.js';

/** Logins, by token. A user is `{ name, admin }`. */
const sessions = new Map();

const USERS = {
  ada: { password: 'analytical', admin: true },
  grace: { password: 'compiler', admin: false },
};

/** A token for the user, or undefined when the name or password is wrong. */
export function logIn(name, password) {
  const user = USERS[name];
  if (!user || user.password !== password) return undefined;
  const token = randomUUID();
  const expires = Date.now() + config.sessionMinutes * 60_000;
  sessions.set(token, { name, admin: user.admin, expires });
  return token;
}

export function logOut(token) {
  sessions.delete(token);
}

/** The user of a request's `Authorization: Bearer <token>` header, if the login is still good. */
export function userOf(request) {
  const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
  const session = token ? sessions.get(token) : undefined;
  if (!session || session.expires < Date.now()) return undefined;
  return { name: session.name, admin: session.admin, token };
}
