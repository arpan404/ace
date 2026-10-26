/**
 * Test child for skill-update-recovery.process.test.ts: applies the fixture's update and stops
 * dead (prints "paused", then waits to be killed) at the Nth descriptor open of a chosen entry.
 * argv[2] is JSON `{home, data, upstream, pause, count}`; `pause` ending in `-` is a prefix.
 */
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SkillLibrary } from "./index.ts";
import { openCommandChild, type OpenCommandChild } from "./posix.ts";

const input = z
  .object({
    home: z.string(),
    data: z.string(),
    upstream: z.string(),
    pause: z.string(),
    count: z.number().int().positive(),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
let armed = false;
let seen = 0;
const matches = (name: string) =>
  input.pause.endsWith("-") ? name.startsWith(input.pause) : name === input.pause;
const openChild: OpenCommandChild = async (directory, name, flags) => {
  if (armed && matches(name) && ++seen === input.count) {
    process.stdout.write("paused\n");
    await new Promise(() => {});
  }
  return openCommandChild(directory, name, flags);
};
let sequence = 0;
const library = new SkillLibrary({
  homes: {
    home: input.home,
    claude: join(input.home, ".claude"),
    codex: join(input.home, ".codex"),
    opencode: join(input.home, ".config/opencode"),
    cursor: join(input.home, ".cursor"),
    pi: join(input.home, ".pi/agent"),
  },
  workspace: () => undefined,
  openChild,
  updates: {
    fetcher: {
      fetch: async (_url, _ref, temporary) => ({ gitRoot: temporary, commit: "c".repeat(40) }),
      treeHash: async () => "b".repeat(40),
      extract: async (_gitRoot, _commit, _folder, destination) =>
        cp(input.upstream, destination, { recursive: true }),
    },
    temporaryRoot: join(input.data, "skill-updates"),
    journalRoot: join(input.data, "skill-update-journals"),
    lockPath: join(input.home, ".agents/.skill-lock.json"),
    now: () => 0,
    id: () => `child${++sequence}`,
  },
  id: () => `child-w${++sequence}`,
});
const listed = await library.request({ op: "list" });
const entry = listed.kind === "list" ? listed.entries.find((e) => e.name === "demo") : undefined;
if (!entry) throw new Error("demo missing");
const prepared = await library.request({ op: "prepareUpdate", id: entry.id });
if (prepared.kind !== "updateReview") throw new Error(JSON.stringify(prepared));
armed = true;
const applied = await library.request({
  op: "applyUpdate",
  id: entry.id,
  reviewId: prepared.review.id,
  expectedHash: prepared.review.baseHash,
});
process.stdout.write(`finished ${applied.kind}\n`);
process.exit(0);
