export interface EngineLimits {
  maxActiveThreads: number;
  maxQueuedFrames: number;
  maxQueuedBytes: number;
  maxFrameBytes: number;
  maxPendingInputs: number;
  maxInputBytes: number;
}
export function engineLimits(input: Partial<EngineLimits> = {}): EngineLimits {
  const limits = {
    maxActiveThreads: 64,
    // Adapters deliver every line of one 64 KiB stdout read synchronously, before the
    // mailbox can drain. The frame cap must sit far above that burst (about 1,100 short
    // JSON-RPC lines); maxQueuedBytes is what bounds memory.
    maxQueuedFrames: 4096,
    maxQueuedBytes: 8 * 1024 * 1024,
    maxFrameBytes: 4 * 1024 * 1024,
    maxPendingInputs: 32,
    maxInputBytes: 262144,
    ...input,
  };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid engine limit");
  return limits;
}
