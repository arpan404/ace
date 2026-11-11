import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  rememberSpadeUpdateMode,
  spadeUpdateModeFile,
  takeSpadeUpdateMode,
} from "./spade-update-mode.ts";

test("the mode left before a restart is used once, then Spade waits for idle again", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-spade-mode-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  expect(await takeSpadeUpdateMode(home)).toBe("idle");
  await rememberSpadeUpdateMode(home, "now");
  expect(await takeSpadeUpdateMode(home)).toBe("now");
  expect(await takeSpadeUpdateMode(home)).toBe("idle");
  await writeFile(join(home, spadeUpdateModeFile), '{"mode":"everything"}');
  expect(await takeSpadeUpdateMode(home)).toBe("idle");
});
