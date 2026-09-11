/** Latest request wins, including failures. Closing drops all outstanding work. */
export function latestRequest<Event>(dispatch: (event: Event) => void) {
  let generation = 0;
  let closed = false;
  return {
    async run(work: (emit: (event: Event) => void) => Promise<void>, error: (err: unknown) => Event) {
      if (closed) return;
      const request = ++generation;
      const emit = (event: Event): void => {
        if (!closed && generation === request) dispatch(event);
      };
      try { await work(emit); } catch (err) { emit(error(err)); }
    },
    close() { closed = true; generation++; },
  };
}
