import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createDaemonCommandLibrary,
  connectDaemonCommandEvents,
  Store,
  createDevThread,
  type CommandEventSource,
} from "./index.ts";
it("local engine events select the thread account, feed runtime commands, record completed usage and clear queued session updates", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-command-events-")));
  const personal = join(home, "personal"),
    work = join(home, "work");
  for (const path of [personal, work]) await mkdir(join(path, "commands"), { recursive: true });
  await writeFile(join(personal, "commands/private.md"), "Personal");
  await writeFile(join(work, "commands/review-alpha.md"), "Alpha");
  await writeFile(join(work, "commands/review-beta.md"), "Beta");
  const store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace(home, "Workspace"),
    thread = createDevThread(store, workspace, "Commands", "claude");
  const id = thread.id;
  const library = createDaemonCommandLibrary(
    store,
    home,
    [
      { id: "personal", provider: "claude", home: personal },
      { id: "work", provider: "claude", home: work },
    ],
    {},
    () => "work",
  );
  let listener: ((event: unknown) => Promise<void>) | undefined;
  const source: CommandEventSource = {
    subscribe(handler) {
      listener = handler;
      return () => {
        listener = undefined;
      };
    },
  };
  const disconnect = connectDaemonCommandEvents(library, source);
  const emit = (event: unknown) => {
    if (!listener) throw new Error("Engine disconnected");
    return listener(event);
  };
  try {
    expect((await library.list(id, "private", 10)).commands).toEqual([]);
    const commands = (await library.list(id, "review-", 10)).commands;
    expect(commands.map((c) => c.name)).toEqual(["review-alpha", "review-beta"]);
    const beta = commands.find((c) => c.name === "review-beta");
    if (!beta) throw new Error("Missing work command");
    await emit({ type: "command.executed", threadId: id, commandId: beta.id });
    expect((await library.list(id, "review-", 1)).commands[0]?.name).toBe("review-beta");
    const frame = { type: "system", subtype: "init", slash_commands: ["runtime-command"] };
    await emit({ type: "commands.runtime", threadId: id, data: frame });
    expect((await library.list(id, "runtime-command", 10)).commands.map((c) => c.name)).toEqual([
      "runtime-command",
    ]);
    const pending = emit({ type: "commands.runtime", threadId: id, data: frame });
    await emit({ type: "session.closed", threadId: id });
    await pending;
    expect((await library.list(id, "runtime-command", 10)).commands).toEqual([]);
    await expect(emit({ type: "command.executed", threadId: id, commandId: 7 })).rejects.toThrow();
    await emit({ type: "commands.runtime", threadId: id, data: frame });
    disconnect();
    expect(listener).toBeUndefined();
    expect((await library.list(id, "runtime-command", 10)).commands).toEqual([]);
  } finally {
    disconnect();
    await library.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
