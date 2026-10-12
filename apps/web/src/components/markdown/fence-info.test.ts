import { expect, test } from "vitest";
import { fenceInfo } from "./fence-info.ts";

test("a fence names its file and language however the agent wrote its info string", () => {
  expect(fenceInfo("ts")).toEqual({ lang: "ts", file: undefined, diff: false });
  expect(fenceInfo('ts title="src/relay/replay.ts"')).toEqual({
    lang: "ts",
    file: "src/relay/replay.ts",
    diff: false,
  });
  expect(fenceInfo("tsx:apps/web/src/app.tsx")).toMatchObject({
    lang: "tsx",
    file: "apps/web/src/app.tsx",
  });
  expect(fenceInfo("python scripts/run.py")).toMatchObject({
    lang: "python",
    file: "scripts/run.py",
  });
  // A bare path names the file; its extension names the language.
  expect(fenceInfo("src/relay/replay.ts")).toMatchObject({
    file: "src/relay/replay.ts",
    lang: "ts",
  });
  expect(fenceInfo("Dockerfile")).toMatchObject({ lang: "Dockerfile", file: undefined });
  expect(fenceInfo("c++")).toMatchObject({ lang: "c++", file: undefined });
  expect(fenceInfo(undefined)).toEqual({ lang: undefined, file: undefined, diff: false });
});

test("diff and patch fences, and .diff files, are diffs", () => {
  expect(fenceInfo("diff").diff).toBe(true);
  expect(fenceInfo("patch").diff).toBe(true);
  expect(fenceInfo("fix.patch").diff).toBe(true);
  expect(fenceInfo("ts").diff).toBe(false);
});
