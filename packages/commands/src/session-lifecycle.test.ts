import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CommandLibrary } from "./index.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function home() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "ace-command-lifecycle-")));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
it("clearing a queued runtime update removes commands and releases its context for eviction", async () => {
  const path = await home();
  const library = new CommandLibrary({
    aceHome: join(path, "ace"),
    instances: [{ id: "personal", provider: "claude", home: join(path, "claude") }],
    now: () => 0,
    context: (thread) => ({
      workspace: join(path, thread),
      provider: "claude",
      instance: "personal",
    }),
  });
  cleanups.push(() => library.close());
  const frame = { type: "system", subtype: "init", slash_commands: ["session-command"] };
  for (let i = 1; i < 8; i++) await library.updateRuntime(`thread-${i}`, frame);
  const pending = library.updateRuntime("thread-0", frame);
  library.clearRuntime("thread-0");
  await pending;
  expect((await library.list("thread-0", "session-command", 10)).commands).toEqual([]);
  expect((await library.list("thread-8", "fork", 10)).commands.map((c) => c.id)).toContain(
    "ace#fork",
  );
  await library.updateRuntime("thread-0", frame);
  expect(
    (await library.list("thread-0", "session-command", 10)).commands.map((c) => c.name),
  ).toEqual(["session-command"]);
});
