/**
 * Hermeticity by enforcement, not convention (plan §6).
 *
 * Network access fails with a stack trace pointing at the offending line
 * instead of a 15-second timeout. WebSocket matters too: realtime-js opens one
 * directly and would sail past a fetch-only stub.
 */
const boom = (what: string) => () => {
  throw new Error(`Network access from a unit test: ${what}. Use the typed fake client.`);
};
globalThis.fetch = boom('fetch');
(globalThis as Record<string, unknown>).WebSocket = boom('WebSocket');
