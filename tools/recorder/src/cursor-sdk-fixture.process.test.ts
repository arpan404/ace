import { mkdtemp, rm } from "node:fs/promises";
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
