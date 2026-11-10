const USERS = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Grace' },
];

export function listUsers() {
  return { status: 200, body: USERS };
}
