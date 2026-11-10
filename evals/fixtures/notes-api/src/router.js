/**
 * A tiny router. A route has a method, a path (`:name` parts become params) and a handler, and
 * says who may call it: anyone, someone logged in (`login`), or an admin (`admin`).
 */
export function createRouter() {
  const routes = [];
  return {
    routes,
    add(method, path, handler, { login = false, admin = false } = {}) {
      routes.push({ method, path, handler, login, admin });
    },
    /** The route for a request and the params of its path, or undefined. */
    find(method, url) {
      for (const route of routes) {
        const params = route.method === method ? match(route.path, url) : undefined;
        if (params) return { route, params };
      }
      return undefined;
    },
  };
}

function match(path, url) {
  const wanted = path.split('/');
  const given = url.split('?')[0].split('/');
  if (wanted.length !== given.length) return undefined;
  const params = {};
  for (const [index, part] of wanted.entries()) {
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(given[index]);
    else if (part !== given[index]) return undefined;
  }
  return params;
}
