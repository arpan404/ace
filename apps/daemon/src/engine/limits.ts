export interface EngineLimits {
  maxActiveThreads: number;
  maxQueuedFrames: number;
  maxQueuedBytes: number;
  maxFrameBytes: number;
}
export function engineLimits(input: Partial<EngineLimits> = {}): EngineLimits {
  const limits = {
    maxActiveThreads: 64,
    maxQueuedFrames: 256,
    maxQueuedBytes: 8 * 1024 * 1024,
    maxFrameBytes: 4 * 1024 * 1024,
    ...input,
  };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid engine limit");
  return limits;
}
