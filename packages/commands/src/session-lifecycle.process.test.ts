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

it("late CLI accounts expose their own native commands and missing accounts still expose ace commands", async () => {
  const path = await home();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const instances: { id: string; provider: "opencode"; home: string }[] = [];
  const library = new CommandLibrary({
    aceHome: join(path, "ace"),
    instances: () => instances,
    now: () => 0,
    context: () => ({ workspace: path, provider: "opencode", instance: "opencode-cli-default" }),
  });
  cleanups.push(() => library.close());
  expect((await library.list("thread", "", 50)).commands.map((c) => c.id)).toContain("ace#fork");
  const config = join(path, "config/opencode");
  await mkdir(join(config, "commands"), { recursive: true });
  await writeFile(
    join(config, "commands/explain.md"),
    "---\ndescription: Explain code\n---\nExplain $ARGUMENTS",
  );
  instances.push({ id: "opencode-cli-default", provider: "opencode", home: config });
  const list = await library.list("thread", "", 50);
  expect(list.commands.map((c) => c.name)).toContain("explain");
  const native = list.commands.find((c) => c.name === "explain");
  if (!native) throw new Error("Missing native command");
  expect(await library.resolve("thread", native.id, {}, ["src/main.ts"])).toMatchObject({
    ok: true,
    plan: { kind: "native", provider: "opencode", text: "/explain src/main.ts" },
  });
  expect((await library.list("thread", "no-such-command", 50)).commands).toEqual([]);
});

it.each(["codex", "claude", "opencode", "cursor", "antigravity", "pi", "acp"] as const)(
  "%s without native discovery returns builtins and a graceful empty search",
  async (provider) => {
    const path = await home();
    const library = new CommandLibrary({
      aceHome: join(path, "ace"),
      instances: [],
      now: () => 0,
      context: () => ({ workspace: path, provider, instance: provider }),
    });
    cleanups.push(() => library.close());
    expect((await library.list("thread", "", 50)).commands.map((c) => c.id)).toContain(
      "ace#review",
    );
    expect((await library.list("thread", "no-such-command", 50)).commands).toEqual([]);
  },
);

it("a full account registry can still list commands for its last registered account", async () => {
  const path = await home();
  const instances = Array.from({ length: 256 }, (_, index) => ({
    id: `account-${index}`,
    provider: "opencode" as const,
    home: path,
  }));
  instances.push(
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `legacy-${index}`,
      provider: "opencode" as const,
      home: path,
    })),
  );
  const library = new CommandLibrary({
    aceHome: path,
    instances,
    now: () => 1,
    context: () => ({ workspace: path, provider: "opencode", instance: "account-255" }),
  });
  try {
    expect((await library.list("thread", "", 50)).commands.map((command) => command.id)).toContain(
      "ace#review",
    );
  } finally {
    await library.close();
  }
});
