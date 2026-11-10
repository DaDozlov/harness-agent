import { createServer } from 'node:http';
import { config } from './config.js';
import { createRouter } from './router.js';
import { healthRoutes } from './routes/health.js';
import { notesRoutes } from './routes/notes.js';
import { sessionRoutes } from './routes/session.js';
import { userOf } from './sessions.js';
import { createStore } from './store.js';

export function createApp() {
  const router = createRouter();
  healthRoutes(router);
  sessionRoutes(router);
  notesRoutes(router, createStore());

  /** Answers one request: `{ status, body }`. */
  return function handle(request, body) {
    const found = router.find(request.method, request.url);
    if (!found) return { status: 404, body: { error: 'Not found.' } };
    const user = userOf(request);
    if (found.route.login && !user) return { status: 401, body: { error: 'Log in first.' } };
    if (found.route.admin && !user.admin) return { status: 403, body: { error: 'Admins only.' } };
    return found.route.handler({ user, body, params: found.params });
  };
}

function readJson(request) {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

// Started with `npm start`, not imported by a test.
if (process.argv[1]?.endsWith('server.js')) {
  const handle = createApp();
  createServer(async (request, response) => {
    const { status, body } = handle(request, await readJson(request));
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body === undefined ? '' : JSON.stringify(body));
  }).listen(config.port, () => console.log(`notes-api on port ${config.port}`));
}
