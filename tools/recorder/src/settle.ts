import type { Recording } from "./recording.ts";
import type { Scenario } from "./scenarios.ts";
export function settleWatcher(rec: Recording, scenario: Scenario, signal: AbortSignal) {
  let open = 0;
  const interactions = { open: () => void open++, close: () => void open-- };
  const settled = (canSettle: () => boolean = () => true, stopSignal?: AbortSignal) =>
    new Promise<void>((done) => {
      const timer = setInterval(() => {
        if (signal.aborted || stopSignal?.aborted) return finish("aborted");
        if (rec.elapsedMs() >= scenario.maxMs) return finish("max-time");
        if (
          rec.marks("turn-end") > 0 &&
          canSettle() &&
          open === 0 &&
          rec.quietForMs() >= scenario.quietMs
        ) {
          finish("settled");
        }
      }, 250);
      function finish(reason: string) {
        clearInterval(timer);
        rec.note("stop", { reason });
        done();
      }
    });
  return { settled, interactions };
}
