export class ScopeSerializer {
  readonly #active = new Set<string>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #waiting = new Map<string, number>();
  readonly #reserved = new Map<string, number>();

  public queued(scopeKey: string): number {
    return Math.max(
      0,
      (this.#waiting.get(scopeKey) ?? 0) -
        (this.#active.has(scopeKey) ? 1 : 0) +
        (this.#reserved.get(scopeKey) ?? 0),
    );
  }

  public reserveQueuePosition(scopeKey: string): () => void {
    this.#reserved.set(scopeKey, (this.#reserved.get(scopeKey) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = Math.max(0, (this.#reserved.get(scopeKey) ?? 0) - 1);
      if (remaining === 0) this.#reserved.delete(scopeKey);
      else this.#reserved.set(scopeKey, remaining);
    };
  }

  public async run<T>(
    scopeKey: string,
    work: () => Promise<T> | T,
  ): Promise<T> {
    const prior = this.#tails.get(scopeKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.#tails.set(scopeKey, tail);
    this.#waiting.set(scopeKey, (this.#waiting.get(scopeKey) ?? 0) + 1);
    await prior;
    this.#active.add(scopeKey);
    try {
      return await work();
    } finally {
      this.#active.delete(scopeKey);
      this.#waiting.set(
        scopeKey,
        Math.max(0, (this.#waiting.get(scopeKey) ?? 0) - 1),
      );
      release?.();
      if (this.#tails.get(scopeKey) === tail) this.#tails.delete(scopeKey);
    }
  }
}
