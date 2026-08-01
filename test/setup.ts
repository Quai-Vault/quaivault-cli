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

/**
 * `data:` is not the network.
 *
 * Ink's layout engine is `yoga-layout`, which loads its WebAssembly from a
 * base64 `data:` URI via `fetch`. Blocking that would block the TUI smoke
 * tests for no safety gain: a data URI carries its own bytes and reaches
 * nothing. Everything with a host still throws.
 */
const realFetch: typeof fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  // `input` is string | URL | Request; only the first two can be a data URI.
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.startsWith('data:')) return realFetch(input, init);
  return boom(`fetch ${url.slice(0, 60)}`)();
};

(globalThis as Record<string, unknown>).WebSocket = boom('WebSocket');

net.connect = boom('net.connect');
net.createConnection = boom('net.createConnection');
net.Socket.prototype.connect = boom('net.Socket#connect');
