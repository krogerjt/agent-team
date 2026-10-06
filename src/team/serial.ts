const tails = new Map<string, Promise<unknown>>();

/** Runs jobs that share a key one at a time, in call order. A failed job does not block the next. */
export function serialize<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(job, job);
  const tail = result.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return result;
}
