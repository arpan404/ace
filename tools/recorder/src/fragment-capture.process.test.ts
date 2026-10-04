import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { cursorSdkCapture } from "./cursor-sdk.ts";

test("new SDK captures keep streamed home and macOS temp paths private without dropping frame coordinates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-fragment-capture-"));
  const workspace = "/private/var/folders/ab/private-temp-id/T/ace-rec-disposable";
  const path = join(directory, "capture.jsonl");
  const capture = cursorSdkCapture(
    path,
    {
      format: "ace-recording/v1",
      provider: "cursor-sdk",
      cliVersion: "1.0.35",
      sdkVersion: "1.0.35",
      model: "composer-2.5",
      scenario: "nested-task",
      sandbox: false,
      autoReview: false,
      checkpointExpected: false,
      startedAt: "2026-10-03T00:00:00.000Z",
      platform: "darwin-arm64",
      workspace,
    },
    { scenario: "nested-task", approved: true },
    { home: "/Users/private-person" },
  );
  const parts = [
    "Inspect /Users/private-",
    "person/.config and /private/var/",
    "folders/ab/private-",
    "temp-id/T/ace-rec-",
    "disposable/src then finish.\n",
  ];
  try {
    for (const [seq, text] of parts.entries())
      await capture.frame(
        {
          seq,
          t: seq,
          dir: "recv",
          channel: "sdk",
          data: {
            schemaVersion: 1,
            operationId: "operation",
            generation: "generation",
            segment: 0,
            agentId: "agent",
            runId: "run",
            kind: "delta",
            boundaryOffset: seq + 1,
            body: { type: "text-delta", text },
          },
        },
        "thread",
        { seq: seq + 100, t: seq + 200 },
      );
    await capture.close();
    const raw = await readFile(path, "utf8");
    expect(raw).not.toMatch(/private-temp|private-person|disposable|\/var\/folders/);
    const Frame = z.object({
      seq: z.number(),
      sourceSeq: z.number(),
      sourceTimeMs: z.number(),
      data: z.object({ body: z.object({ text: z.string() }) }),
    });
    const frames = raw
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => Frame.parse(JSON.parse(line)));
    expect(frames.map((frame) => [frame.seq, frame.sourceSeq, frame.sourceTimeMs])).toEqual(
      parts.map((_part, seq) => [seq, seq + 100, seq + 200]),
    );
    expect(frames.map((frame) => frame.data.body.text).join("")).toBe(
      "Inspect <HOME>/.config and <WORKSPACE>/src then finish.\n",
    );
  } finally {
    await capture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
