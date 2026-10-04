import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  readFixture,
  replayFixture,
  readExpectations,
  assertExpectations,
} from "@ace/adapter-testkit";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { cursorSdkCapture, CursorSdkCaptureHeader } from "./cursor-sdk.ts";

const cases = [
  "full-access",
  "text-thinking-read",
  "edit-shell-results",
  "plan-question",
  "foreground-child",
  "background-child",
  "nested-task",
  "background-shell",
  "interrupt-work",
  "steering-restart",
  "checkpoint-resume",
  "portable-fork",
  "usage",
];
const SourceCoordinates = z.object({
  threadId: z.string().optional(),
  sourceSeq: z.number().optional(),
  sourceTimeMs: z.number().optional(),
});
it.each([
  "/Users/private-person-name/private-file.txt",
  "/var/folders/zz/private-temp-identifier/T/disposable-workspace/private-file.txt",
])("records a full carry window and another agent's boundary without leaking %s", async (path) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-carry-sink-"));
  const output = join(root, "capture.jsonl");
  const capture = cursorSdkCapture(
    output,
    {
      format: "ace-recording/v1",
      provider: "cursor-sdk",
      cliVersion: "1.0.35",
      sdkVersion: "1.0.35",
      model: "composer-2.5",
      scenario: "nested-task",
      sandbox: false,
      autoReview: false,
      checkpointExpected: true,
      startedAt: "2026-10-03T00:00:00.000Z",
      platform: "synthetic",
      workspace: "/var/folders/zz/private-temp-identifier/T/disposable-workspace",
    },
    { scenario: "nested-task", approved: true },
  );
  let seq = 0;
  async function text(threadId: string, value: string) {
    await capture.frame(
      {
        seq: ++seq,
        t: seq,
        dir: "recv",
        channel: "sdk",
        data: {
          schemaVersion: 1,
          generation: "synthetic",
          operationId: threadId,
          agentId: threadId,
          segment: 0,
          kind: "delta",
          body: { type: "text", text: value },
        },
      },
      threadId,
    );
  }
  try {
    for (let index = 0; index < 32; index++) {
      const fragment = path.slice(
        Math.floor((path.length * index) / 32),
        Math.floor((path.length * (index + 1)) / 32),
      );
      await text("child", (index === 0 ? "see (" : "") + fragment);
    }
    // This one call flushes the full carry window AND the parent's boundary record.
    await text("parent", "done\n");
    await text("child", "-private-continuation)\n");
    await capture.close();
    const fixture = await readFixture(output);
    expect(fixture.frames.map((frame) => frame.seq)).toEqual(
      Array.from({ length: 34 }, (_, index) => index + 1),
    );
    expect(fixture.threads?.["child"]).toHaveLength(33);
    expect(fixture.threads?.["parent"]).toHaveLength(1);
    const body = z.object({ body: z.object({ text: z.string() }) });
    expect(body.parse(fixture.threads?.["parent"]?.[0]?.data).body.text).toBe("done\n");
    const childText = fixture.threads?.["child"]
      ?.map((frame) => body.parse(frame.data).body.text)
      .join("");
    expect(childText).toBe("see <FRAGMENT OMITTED>\n");
    expect(await readFile(output, "utf8")).not.toMatch(
      /private-person|private-temp-identifier|disposable-workspace|private-continuation/,
    );
  } finally {
    await capture.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(cases)(
  "round-trips recorded %s evidence through the bounded sink without changing terminal state or thread ownership",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "cursor-sdk-fixture-sink-"));
    const source = fileURLToPath(
      new URL(
        `../../../fixtures/cursor-sdk/1.0.35/composer-2.5/${scenario}.jsonl`,
        import.meta.url,
      ),
    );
    try {
      const fixture = await readFixture(source);
      const path = join(root, "copy.jsonl");
      const capture = cursorSdkCapture(path, CursorSdkCaptureHeader.parse(fixture.header), {
        scenario,
        approved: true,
      });
      try {
        for (const metadata of fixture.metadata ?? [])
          if (metadata.type === "sdk-model-catalog") await capture.metadata(metadata.models);
        for (const frame of fixture.frames) {
          const coordinates = SourceCoordinates.parse(frame);
          await capture.frame(
            frame,
            coordinates.threadId,
            coordinates.sourceSeq !== undefined && coordinates.sourceTimeMs !== undefined
              ? { seq: coordinates.sourceSeq, t: coordinates.sourceTimeMs }
              : undefined,
          );
        }
        for (const metadata of fixture.metadata ?? [])
          if (metadata.type === "sdk-scenario-analysis")
            await capture.analysis(metadata.observations);
      } finally {
        await capture.close();
      }
      const copy = await readFixture(path);
      expect(copy.metadata?.find((value) => value.type === "sdk-scenario-analysis")).toEqual(
        fixture.metadata?.find((value) => value.type === "sdk-scenario-analysis"),
      );
      for (const [index, [threadId, frames]] of Object.entries(
        copy.threads ?? { "replay-thread": copy.frames },
      ).entries()) {
        const result = replayFixture({
          fixture: { ...copy, frames },
          threadId,
          createTranslator: createCursorAdapter().createTranslator,
          coreConfig: { provider: "cursor", silenceMs: 90000 },
        });
        const suffix =
          scenario === "portable-fork"
            ? index === 0
              ? ".source.expect.json"
              : ".fork.expect.json"
            : ".expect.json";
        assertExpectations(result, await readExpectations(source.replace(".jsonl", suffix)));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
