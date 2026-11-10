The server has seven routes (`src/routes/`):

| Route | Login |
|---|---|
| `GET /healthz` | no |
| `POST /login` | no |
| `POST /logout` | yes |
| `GET /notes` | yes |
| `POST /notes` | yes |
| `GET /notes/:id` | yes |
| `DELETE /notes/:id` | yes, and only for admins |

A note can have at most 500 characters (`maxNoteLength` in `src/config.js`).
