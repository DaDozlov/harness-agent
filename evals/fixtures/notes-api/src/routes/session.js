import { logIn, logOut } from '../sessions.js';

export function sessionRoutes(router) {
  router.add('POST', '/login', ({ body }) => {
    const token = logIn(body?.name, body?.password);
    return token
      ? { status: 200, body: { token } }
      : { status: 401, body: { error: 'Wrong name or password.' } };
  });

  router.add(
    'POST',
    '/logout',
    ({ user }) => {
      logOut(user.token);
      return { status: 204 };
    },
    { login: true },
  );
}
