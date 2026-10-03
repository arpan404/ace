import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  readFixture,
  replayFixture,
  readExpectations,
  assertExpectations,
} from "@ace/adapter-testkit";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { cursorSdkCapture, CursorSdkCaptureHeader } from "./cursor-sdk.ts";

it("round-trips the real SDK recording through the bounded sink without losing failed-shell evidence or tree settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-fixture-sink-"));
  const source = fileURLToPath(
    new URL("../../../fixtures/cursor-sdk/1.0.35/composer-2.5/full-access.jsonl", import.meta.url),
  );
  try {
    const fixture = await readFixture(source);
    const path = join(root, "copy.jsonl");
    const capture = cursorSdkCapture(path, CursorSdkCaptureHeader.parse(fixture.header), {
      scenario: "full-access",
      approved: true,
    });
    try {
      for (const metadata of fixture.metadata ?? [])
        if (metadata.type === "sdk-model-catalog") await capture.metadata(metadata.models);
      for (const frame of fixture.frames) await capture.frame(frame);
      for (const metadata of fixture.metadata ?? [])
        if (metadata.type === "sdk-scenario-analysis")
          await capture.analysis(metadata.observations);
    } finally {
      await capture.close();
    }
    const result = replayFixture({
      fixture: await readFixture(path),
      createTranslator: createCursorAdapter().createTranslator,
      coreConfig: { provider: "cursor", silenceMs: 90000 },
    });
    assertExpectations(result, await readExpectations(source.replace(".jsonl", ".expect.json")));
    expect(
      Object.values(result.final.view.items).flatMap((item) =>
        item.type === "tool_call" ? [item.call.status] : [],
      ),
    ).toEqual(["succeeded", "failed", "succeeded"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
