export function notesRoutes(router, store) {
  const mine = { login: true };

  router.add('GET', '/notes', ({ user }) => ({ status: 200, body: store.list(user.name) }), mine);

  router.add(
    'POST',
    '/notes',
    ({ user, body }) => {
      try {
        return { status: 201, body: store.add(user.name, body?.text) };
      } catch (error) {
        return { status: 400, body: { error: error.message } };
      }
    },
    mine,
  );

  router.add(
    'GET',
    '/notes/:id',
    ({ user, params }) => {
      const note = store.get(params.id);
      return note && note.owner === user.name
        ? { status: 200, body: note }
        : { status: 404, body: { error: 'No such note.' } };
    },
    mine,
  );

  // Removing is for admins: they clean up after everybody.
  router.add(
    'DELETE',
    '/notes/:id',
    ({ params }) => ({ status: store.remove(params.id) ? 204 : 404 }),
    { login: true, admin: true },
  );
}
