import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { TerminalManagerOptions } from "@ace/terminal";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

// The PTY boundary echoes input and reports shutdown, without starting a provider or shell.
const ignore = () => {};

function ptys(): { terminal: TerminalManagerOptions; stopped: string[] } {
  const stopped: string[] = [];
  return {
    stopped,
    terminal: {
      dependencies: {
        backendFactory(options) {
          let data: (bytes: Buffer) => void = ignore;
          let exit: (status: { code: number; signal: null }) => void = ignore;
          return {
            pid: process.pid,
            write: (text) => data(Buffer.from(text)),
            resize() {},
            onData(listener) {
              data = listener;
              return () => {
                data = () => {};
              };
            },
            onExit(listener) {
              exit = listener;
              return () => {
                exit = () => {};
              };
            },
            async kill() {
              exit({ code: 0, signal: null });
            },
            async close() {
              stopped.push(options.name);
              exit({ code: 0, signal: null });
            },
          };
        },
      },
    },
  };
}

test("pre-restart terminal handles cannot close, write, resize or subscribe to a replacement shell", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-terminal-lifetime-"));
  const store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace(home, "Fixture");
  const thread = createDevThread(store, workspace);
  const edge = ptys();
  const before = new WorkspaceRuntime(store, home, () => 1000, { terminal: edge.terminal });
  const after = new WorkspaceRuntime(store, home, () => 2000, { terminal: edge.terminal });
  try {
    const old = await before.openTerminal(thread.id, "before restart");
    await before.close();
    const current = await after.openTerminal(thread.id, "after restart");
    await expect(after.closeTerminal(old, thread.id)).rejects.toThrow("terminal_not_found");
    expect(() => after.terminal(old, thread.id).write("stale")).toThrow("terminal_not_found");
    expect(() => after.terminal(old, thread.id).resize(90, 30)).toThrow("terminal_not_found");
    expect(() => after.terminal(old, thread.id).attach({})).toThrow("terminal_not_found");
    expect(current).not.toBe(old);
    after.terminal(current, thread.id).write("replacement alive");
    expect(
      Buffer.from(after.terminal(current, thread.id).snapshot().data, "base64").toString(),
    ).toBe("replacement alive");
    expect(after.listTerminals(thread.id).map((entry) => entry.id)).toEqual([current]);
    expect(edge.stopped).toEqual(["before restart"]);
    await after.closeTerminal(current, ThreadId.parse(thread.id));
    expect(after.listTerminals(thread.id)).toEqual([]);
  } finally {
    await before.close();
    await after.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
