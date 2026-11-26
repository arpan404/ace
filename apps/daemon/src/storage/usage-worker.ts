import { UsageWorkerRequest, type UsageWorkerReply } from "./usage-worker-wire.ts";
import { measureTranscripts, scanUsage } from "./usage-worker-scan.ts";

const cancellation = new AbortController();
let started = false;
function reply(message: UsageWorkerReply, close = true): void {
  if (!process.connected || !process.send) return;
  process.send(message, () => {
    if (close && process.connected) process.disconnect?.();
  });
}
process.on("disconnect", () => cancellation.abort());
process.on("message", (raw: unknown) => {
  const request = UsageWorkerRequest.safeParse(raw);
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
  const input = request.data;
  const transcripts = input.op === "transcripts";
  const result: Promise<UsageWorkerReply> = transcripts
    ? measureTranscripts(input, cancellation.signal).then<UsageWorkerReply>((bytes) => ({
        kind: "transcripts",
        bytes,
      }))
    : scanUsage(input, cancellation.signal).then<UsageWorkerReply>((usage) => ({
        kind: "usage",
        usage,
      }));
  void result
    .then(
      (message) => {
        if (transcripts) started = false;
        reply(message, !transcripts);
      },
      () => reply({ kind: "error", code: "storage_usage_failed" }),
    )
    .catch(() => {
      process.exitCode = 1;
      if (process.connected) process.disconnect?.();
    });
});
