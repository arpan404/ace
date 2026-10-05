/** Only measured timing violations and subprocess deadlines qualify for a second sample. */
export class TimingFailure extends Error {}

/** Repeat the complete, unchanged workload once; a second failure always escapes. */
export async function retryTiming<T>(
  measure: () => Promise<T>,
  report: (first: TimingFailure) => void,
): Promise<T> {
  try {
    return await measure();
  } catch (error) {
    if (!(error instanceof TimingFailure)) throw error;
    report(error);
    return measure();
  }
}
export { liveWorkerTelemetry } from "./worker-telemetry.ts";
