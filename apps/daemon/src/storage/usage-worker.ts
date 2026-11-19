import { UsageWorkerRequest } from "./usage-worker-wire.ts";
import { scanUsage } from "./usage-worker-scan.ts";

const cancellation = new AbortController();
let started = false;
function reply(message: unknown): void {
  if (!process.connected || !process.send) return;
  process.send(message, () => {
    if (process.connected) process.disconnect?.();
  });
}
process.on("disconnect", () => cancellation.abort());
process.on("message", (input: unknown) => {
  const request = UsageWorkerRequest.safeParse(input);
  if (!request.success) {
    cancellation.abort();
    reply({ kind: "error", code: "storage_usage_failed" });
    return;
  }
  if (request.data.op === "cancel") {
    cancellation.abort();
    return;
  }
  if (started) return;
  started = true;
  void scanUsage(request.data, cancellation.signal)
    .then(
      (usage) => reply({ kind: "usage", usage }),
      () => reply({ kind: "error", code: "storage_usage_failed" }),
    )
    .catch(() => {
      process.exitCode = 1;
      if (process.connected) process.disconnect?.();
    });
});
