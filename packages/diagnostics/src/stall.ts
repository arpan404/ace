/** Main-thread freeze watchdog shared by the daemon and the desktop main process. */
export {
  startStallWatchdog,
  takePreviousStallReports,
  defaultStallTiming,
  systemHeartbeat,
  type HeartbeatClock,
  type StallWatchdogOptions,
  type StallWatchdogTiming,
  type StallWorkerFactory,
} from "./stall-watchdog.ts";
export { StallReport, stallFields, describeFrame, type StallFrame } from "./stall-report.ts";
export { createStallOperation, type StallOperation } from "./stall-operation.ts";
