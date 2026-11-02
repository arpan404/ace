// Test child: starts the stall watchdog, then freezes its main thread until it is killed.
import { setTimeout as delay } from "node:timers/promises";
import { startStallWatchdog, systemHeartbeat } from "./stall-watchdog.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Report directory required");
startStallWatchdog({
  directory,
  pid: process.pid,
  clock: systemHeartbeat,
  timing: { beatMs: 50, checkMs: 50, thresholdMs: 400, repeatMs: 2_000, cooldownMs: 0 },
  onStall: () => {},
  onError: () => {},
});
await delay(500);
(function freezeForever() {
  for (;;) performance.now();
})();
