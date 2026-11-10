import { routes } from './generated/routes.js';

/** Answers a request with the route's handler: `{ status, body }`. */
export function handle(method, path) {
  const route = routes.find((item) => item.method === method && item.path === path);
  return route ? route.handler() : { status: 404, body: { error: 'Not found' } };
}
