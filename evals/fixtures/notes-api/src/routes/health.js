export function healthRoutes(router) {
  router.add('GET', '/healthz', () => ({ status: 200, body: { ok: true } }));
}
