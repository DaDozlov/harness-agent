# Plan: A small in-memory task store

## Goal
A task store other modules can use: add, get, list and remove tasks, kept in memory.
Non-goals: saving to disk, a command line.

## Requirements
- A task has an id (a number the store gives out, starting at 1), a title and a done flag.
- Done when: the four functions work and are tested, and the README shows how to use them.

## Design
`createStore()` in `src/store.js` returns an object with the functions. Tasks live in a `Map`
by id, which keeps them in the order they were added.

## Tests
`test/store.test.js`, with Node's test runner: each function, and what it does for an id that
does not exist.

## Steps
- [x] 1. Skeleton: `createStore()` with `add(title)`, and one passing test. Check: `npm test`
- [x] 2. `get(id)` and `list()`, with tests. Check: `npm test`
- [x] 3. `remove(id)`: removes the task and returns `true`, or returns `false` when there is no such task; with tests. Check: `npm test`
- [x] 4. `README.md`: a "Usage" section with a short example that uses `add`, `get`, `list` and `remove`. Check: the README names all four functions
