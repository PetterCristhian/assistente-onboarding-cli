// Shared by tests/helpers/preload-loopback-only.ts and the tests that read
// what it prints. Kept apart because importing the preload itself would block
// the network of the test process.
export const LOOPBACK_ONLY_CONNECT_MARKER = "[loopback-only] connect";
export const LOOPBACK_ONLY_BLOCKED_MARKER = "[loopback-only] blocked";
export const LOOPBACK_ONLY_BLOCK_MESSAGE =
  "network blocked by the test (only 127.0.0.1 is allowed)";
