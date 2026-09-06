export interface ExclusiveRunGateSnapshot {
  active: number;
  waiting: number;
}

export interface ExclusiveRunGate {
  run<T>(task: () => Promise<T>): Promise<T>;
  snapshot(): ExclusiveRunGateSnapshot;
}

export function createExclusiveRunGate(): ExclusiveRunGate {
  let tail: Promise<void> = Promise.resolve();
  let active = 0;
  let waiting = 0;

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>(resolve => {
        release = resolve;
      });
      waiting++;

      try {
        await previous.catch(() => undefined);
        waiting--;
        active++;
        return await task();
      } finally {
        if (active > 0) active--;
        else if (waiting > 0) waiting--;
        release();
      }
    },

    snapshot(): ExclusiveRunGateSnapshot {
      return { active, waiting };
    },
  };
}
