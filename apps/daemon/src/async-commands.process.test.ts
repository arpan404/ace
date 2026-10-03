import { mkdtemp, rm, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { Store } from "./store.ts";
import { AsyncCommands } from "./async-commands.ts";
const command = Command.parse({
  id: "effect",
  deviceId: "desktop",
  payload: { type: "workspace.editor.open", threadId: "thread", editorId: "code" },
});
test("concurrent command retries share one external effect and a completed receipt survives restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-async-commands-"));
  const path = join(root, "events.sqlite");
  const store = new Store(path);
  const commands = new AsyncCommands(store);
  let release = noop;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = noop;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const effect = async () => {
    await appendFile(join(root, "effects"), "A");
    entered();
    await gate;
    return { ok: true };
  };
  try {
    const first = commands.run(command, effect);
    await started;
    const second = commands.run(command, effect);
    expect(
      await commands.run(Command.parse({ ...command, deviceId: "stranger" }), effect),
    ).toMatchObject({ ok: false, error: "forbidden" });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    const cold = new Store(path);
    try {
      const replay = new AsyncCommands(cold);
      expect(
        await replay.run(command, async () => {
          await appendFile(join(root, "effects"), "B");
          return { ok: true };
        }),
      ).toMatchObject({ ok: true });
    } finally {
      cold.close();
    }
    expect(await readFile(join(root, "effects"), "utf8")).toBe("A");
  } finally {
    release();
    await commands.drained();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an uncertain external effect after restart is reported rather than performed again", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-uncertain-command-"));
  const path = join(root, "events.sqlite");
  const store = new Store(path);
  const commands = new AsyncCommands(store);
  let release = noop;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = noop;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = commands.run(command, async () => {
    await appendFile(join(root, "effects"), "A");
    entered();
    await gate;
    return { ok: true };
  });
  try {
    await started;
    const cold = new Store(path);
    try {
      const replay = new AsyncCommands(cold);
      expect(
        await replay.run(command, async () => {
          await appendFile(join(root, "effects"), "B");
          return { ok: true };
        }),
      ).toMatchObject({ ok: false, error: "action_outcome_uncertain" });
    } finally {
      cold.close();
    }
    release();
    await pending;
    expect(await readFile(join(root, "effects"), "utf8")).toBe("A");
  } finally {
    release();
    await commands.drained();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function noop(): void {}
