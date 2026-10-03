import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { boundedJson, RpcWriter } from "@ace/provider-kit/ipc";
import { createRedactor } from "@ace/redaction";
import type { Frame } from "@ace/engine-api";
import { z } from "zod";
import { CursorSdkApproval, CursorSdkScenario } from "../cursor-sdk-plan.ts";
import { CursorEnvelopeSchema } from "@ace/adapter-cursor";
import type { RedactionContext } from "@ace/redaction";
import { ProviderPayload } from "@ace/provider-kit/payload";

export const CursorSdkCaptureHeader = z.strictObject({
  format: z.literal("ace-recording/v1"),
  provider: z.literal("cursor-sdk"),
  cliVersion: z.literal("1.0.35"),
  sdkVersion: z.literal("1.0.35"),
  model: z.literal("composer-2.5"),
  scenario: CursorSdkScenario,
  sandbox: z.boolean(),
  autoReview: z.boolean(),
  checkpointExpected: z.boolean(),
  instanceId: z.string().min(1).max(256).optional(),
  startedAt: z.iso.datetime(),
  platform: z.string().min(1).max(128),
  workspace: z.string().min(1).max(4096),
});
export type CursorSdkCaptureHeader = z.infer<typeof CursorSdkCaptureHeader>;
/** Passive SDK-boundary sink. It cannot sign in, launch an adapter or spend quota. */
export function cursorSdkCapture(
  path: string,
  header: CursorSdkCaptureHeader,
  approval: unknown,
  context: RedactionContext = {},
) {
  const permitted = CursorSdkApproval.parse(approval);
  header = CursorSdkCaptureHeader.parse(header);
  if (permitted.scenario !== header.scenario) throw new Error("Owner scenario approval required");
  const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const scrub = createRedactor({ ...context, workspace: header.workspace }, ["text"]);
  const writer = new RpcWriter(output, 1_048_576);
  let failure: unknown;
  let queued = 0;
  let bytes = 0;
  let totalBytes = 0;
  let captureSeq = 0;
  let tail: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const write = (input: unknown) => {
    if (closing) throw new Error("SDK capture is closing");
    if (failure) throw new Error("SDK capture failed; no further frames accepted");
    const line = scrub(boundedJson(input, 262144)) + "\n";
    const size = Buffer.byteLength(line);
    if (totalBytes + size > 33554432) throw new Error("SDK capture exceeds recording byte budget");
    if (queued >= 32 || bytes + size > 1_048_576)
      throw new Error("SDK capture backlog exceeded budget");
    queued++;
    bytes += size;
    totalBytes += size;
    const task = tail
      .then(async () => {
        await writer.send(line, size);
      })
      .finally(() => {
        queued--;
        bytes -= size;
      });
    tail = task;
    void task.catch((error: unknown) => {
      failure = error;
    });
    return task;
  };
  void write(header);
  return {
    frame(frame: Frame, threadId?: string) {
      if (frame.channel !== "sdk")
        throw new Error("SDK recordings must not contain ACP/auth frames");
      const payload =
        frame.payload && ProviderPayload.is(frame.payload) && frame.payload.data === frame.data
          ? frame.payload
          : new ProviderPayload(boundedJson(frame.data, 262144));
      if (payload.bytes > 262144) throw new Error("SDK capture frame exceeds budget");
      const data = CursorEnvelopeSchema.parse(payload.data);
      if (/auth|login|logout/.test(data.kind))
        throw new Error("SDK auth frames cannot be recorded");
      return write({
        captureSeq: ++captureSeq,
        ...(threadId ? { threadId: z.string().max(512).parse(threadId) } : {}),
        seq: frame.seq,
        t: frame.t,
        dir: frame.dir,
        channel: "sdk",
        data,
      });
    },
    metadata(models: unknown) {
      return write({
        type: "sdk-model-catalog",
        sdkVersion: "1.0.35",
        model: "composer-2.5",
        models,
      });
    },
    analysis(observations: unknown) {
      return write({ type: "sdk-scenario-analysis", observations });
    },
    close() {
      closing ??= (async () => {
        try {
          await tail;
          const finished = once(output, "finish");
          output.end();
          await finished;
        } catch {
          output.destroy();
          throw new Error("SDK capture failed; partial recording is unusable");
        }
      })();
      return closing;
    },
  };
}
