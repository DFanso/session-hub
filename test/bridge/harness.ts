// Fake clock and fake stdin/stdout for driving runBridge in tests and in make-fixtures.ts.

/** Lets every pending promise callback run. */
export function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

export class FakeClock {
  t: number;
  private timers: { at: number; resolve: () => void }[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now = (): number => this.t;

  sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      this.timers.push({ at: this.t + ms, resolve });
    });

  /** Moves time forward, firing every timer due on the way, in order. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    this.t = end;
    await flush();
  }
}

export type Out = Record<string, unknown> & { type: string };

export class FakeIo {
  /** Every line written, raw. */
  readonly raw: string[] = [];
  private queue: string[] = [];
  private ended = false;
  private wake: (() => void) | null = null;

  write = (line: string): void => {
    this.raw.push(line);
  };

  get out(): Out[] {
    return this.raw.map((l) => JSON.parse(l) as Out);
  }

  of(type: string): Out[] {
    return this.out.filter((o) => o.type === type);
  }

  push(line: string): void {
    this.queue.push(line);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  readonly lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<string>> => {
        for (;;) {
          const line = this.queue.shift();
          if (line !== undefined) return { value: line, done: false };
          if (this.ended) return { value: undefined, done: true };
          await new Promise<void>((r) => {
            this.wake = r;
          });
          this.wake = null;
        }
      },
    }),
  };
}
