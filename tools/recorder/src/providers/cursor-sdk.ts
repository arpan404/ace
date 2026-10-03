import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { boundedJson, RpcWriter } from "@ace/provider-kit/ipc";
import { createRedactor } from "@ace/redaction";
import type { Frame } from "@ace/engine-api";
import type { CursorSdkScenarioId } from "../cursor-sdk-scenarios.ts";

export interface CursorSdkCaptureHeader {
  format: "ace-recording/v1";
  provider: "cursor-sdk";
  cliVersion: "1.0.35";
  sdkVersion: "1.0.35";
  model: "composer-2.5";
  scenario: CursorSdkScenarioId;
  sandbox: boolean;
  autoReview: boolean;
  checkpointExpected: boolean;
  startedAt: string;
  platform: string;
  workspace: string;
}
/** Passive SDK-boundary sink. It cannot sign in, launch an adapter or spend quota. */
export function cursorSdkCapture(
  path: string,
  header: CursorSdkCaptureHeader,
  approval: { scenario: CursorSdkScenarioId; approved: true },
) {
  if (approval.approved !== true || approval.scenario !== header.scenario)
    throw new Error("Owner scenario approval required");
  const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const scrub = createRedactor({ workspace: header.workspace }, ["text"]);
  const writer = new RpcWriter(output, 1_048_576);
  let failure: unknown;
  let queued = 0;
  let bytes = 0;
  let tail: Promise<void> = Promise.resolve();
  const write = (input: unknown) => {
    if (failure) throw new Error("SDK capture failed; no further frames accepted");
    const line = scrub(boundedJson(input, 262144)) + "\n";
    const size = Buffer.byteLength(line);
    if (queued >= 32 || bytes + size > 1_048_576)
      throw new Error("SDK capture backlog exceeded budget");
    queued++;
    bytes += size;
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
    frame(frame: Frame) {
      if (frame.channel !== "sdk")
        throw new Error("SDK recordings must not contain ACP/auth frames");
      return write({
        seq: frame.seq,
        t: frame.t,
        dir: frame.dir,
        channel: "sdk",
        data: frame.data,
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
    async close() {
      try {
        await tail;
        const finished = once(output, "finish");
        output.end();
        await finished;
      } catch {
        output.destroy();
        throw new Error("SDK capture failed; partial recording is unusable");
      }
    },
  };
}
