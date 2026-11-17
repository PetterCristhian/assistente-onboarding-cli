// Shared by tests/helpers/preload-fake-fetch.ts and the tests that read what
// it prints. Kept apart because importing the preload itself would block the
// network of the test process.
export const FAKE_FETCH_MARKER = "[fake-fetch] call";
export const FAKE_FETCH_BLOCK_MESSAGE = "network blocked by the test";
export const FAKE_FETCH_ANSWER = "Resposta falsa do teste.";
