import { Item, TurnStepsResponse } from "@ace/protocol";

export function step(id: string, seq: number) {
  return {
    seq,
    item: Item.parse({
      id,
      agentId: "root",
      type: "reasoning",
      text: id,
      complete: true,
      createdAt: 1,
    }),
  };
}

type ReadInput = { turnOrdinal: number; after?: number | undefined; limit?: number | undefined };

/** A daemon whose turns hold `size` steps each, read in pages of up to 200. */
export function daemon(size: (ordinal: number) => number, endSeq = 10) {
  const reads: { ordinal: number; after: number | undefined }[] = [];
  return {
    reads,
    read: async (input: ReadInput): Promise<TurnStepsResponse> => {
      reads.push({ ordinal: input.turnOrdinal, after: input.after });
      const from = input.after ?? 0;
      const total = size(input.turnOrdinal);
      const count = Math.min(input.limit ?? 100, total - from);
      return TurnStepsResponse.parse({
        type: "turn.steps",
        requestId: "r",
        threadId: "t",
        turnOrdinal: input.turnOrdinal,
        seq: 99,
        endSeq,
        steps: Array.from({ length: count }, (_, index) =>
          step(`${input.turnOrdinal}-${from + index + 1}`, from + index + 1),
        ),
        after: from + count < total ? from + count : null,
      });
    },
  };
}

/** A daemon that never answers: what shows meanwhile came from memory or the store. */
export function silentDaemon() {
  const reads: { ordinal: number; signal: AbortSignal | undefined }[] = [];
  return {
    reads,
    read: (input: ReadInput, options: { signal?: AbortSignal | undefined }) => {
      reads.push({ ordinal: input.turnOrdinal, signal: options.signal });
      return new Promise<TurnStepsResponse>(() => {});
    },
  };
}

/** A daemon that refuses every read. */
export function failingDaemon() {
  return { read: async (): Promise<TurnStepsResponse> => Promise.reject(new Error("unavailable")) };
}

export function timers() {
  const pending: { run: () => void; cancelled: boolean }[] = [];
  return {
    schedule(run: () => void) {
      const timer = { run, cancelled: false };
      pending.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fire() {
      for (const timer of pending.splice(0)) if (!timer.cancelled) timer.run();
    },
  };
}

/** A store in memory, written through JSON as a browser's would be. */
export function memoryStore() {
  const records = new Map<string, string>();
  return {
    records,
    async get(key: string): Promise<unknown> {
      const text = records.get(key);
      return text === undefined ? undefined : JSON.parse(text);
    },
    async set(key: string, value: unknown): Promise<void> {
      records.set(key, JSON.stringify(value));
    },
  };
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
