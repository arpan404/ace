import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { Command } from "@ace/protocol";
import { scriptedProvider } from "./scripted.ts";

test("the measurement provider starts under default permissions and persists its scripted stream", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-perf-script-"));
  const store = new Store(join(home, "events.sqlite"));
  const provider = scriptedProvider();
  const registry = new AdapterRegistry();
  registry.register(provider.adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
  const engine = new Engine(store, { registry });
  try {
    await engine.ready();
    const workspaceId = store.createWorkspace(home, "Measurement");
    const command = Command.parse({
      id: "start-script",
      deviceId: "perf",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "codex",
        input: [{ type: "text", text: "script" }],
      },
    });
    const result = store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, store),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.threadId) throw new Error("Missing measurement thread");
    await engine.flush();
    await provider.emit(result.threadId, 42);
    await engine.flush();
    const events = store.readEvents({ afterSeq: 0, threadId: result.threadId, limit: 256 });
    const delta = events.find((event) => event.payload.type === "item.delta");
    if (delta?.payload.type !== "item.delta") throw new Error("Missing scripted stream");
    expect(JSON.parse(delta.payload.append)).toMatchObject({ index: 42 });
    await provider.finish(result.threadId);
    await engine.flush();
    expect(store.getThread(result.threadId)?.status.state).toBe("done");
  } finally {
    await engine.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
