import net from 'node:net';

/**
 * Hermeticity by enforcement, not convention (plan §6).
 *
 * Network access fails with a stack trace pointing at the offending line
 * instead of a 15-second timeout. Three sinks, because one is not enough:
 *
 *   fetch           the obvious one, and the only one postgrest-js uses.
 *   WebSocket       realtime-js opens one directly and would sail straight
 *                   past a fetch-only stub.
 *   net.connect     the floor. `http.request` never touches `fetch`; it
 *                   constructs a Socket and connects it. Patching the
 *                   prototype method rather than just the module-level
 *                   helpers is what closes that path.
 */
const boom = (what: string) => () => {
  throw new Error(`Network access from a unit test: ${what}. Use the typed fake client.`);
};

globalThis.fetch = boom('fetch');
(globalThis as Record<string, unknown>).WebSocket = boom('WebSocket');

net.connect = boom('net.connect') as never;
net.createConnection = boom('net.createConnection') as never;
net.Socket.prototype.connect = boom('net.Socket#connect') as never;
