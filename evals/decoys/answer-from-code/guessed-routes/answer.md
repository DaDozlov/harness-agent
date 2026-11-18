The server has routes for health checks, login, and notes (`src/routes/`):

- `GET /healthz`
- `POST /login`
- `GET /notes`, `POST /notes`, `GET /notes/:id`, `DELETE /notes/:id`

All note routes need a login. A note can probably be about 1000 characters long.
