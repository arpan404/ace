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
    // Intake pauses at 256 frames and resumes at 64; these are last-resort limits
    // for faulty adapters. An exhausted mailbox ends its session and can be resumed.
    maxQueuedFrames: 16384,
    maxQueuedBytes: 16 * 1024 * 1024,
    maxFrameBytes: 4 * 1024 * 1024,
    maxPendingInputs: 32,
    maxInputBytes: 262144,
    ...input,
  };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid engine limit");
  return limits;
}
