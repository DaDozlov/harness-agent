import { config } from './config.js';

/** Notes in memory, by id. */
export function createStore() {
  const notes = new Map();
  let nextId = 1;
  return {
    list: (owner) => [...notes.values()].filter((note) => note.owner === owner),
    get: (id) => notes.get(Number(id)),
    add(owner, text) {
      if (typeof text !== 'string' || !text.trim()) throw new RangeError('A note needs a text.');
      if (text.length > config.maxNoteLength) {
        throw new RangeError(`A note can have at most ${config.maxNoteLength} characters.`);
      }
      const note = { id: nextId++, owner, text };
      notes.set(note.id, note);
      return note;
    },
    remove: (id) => notes.delete(Number(id)),
  };
}
