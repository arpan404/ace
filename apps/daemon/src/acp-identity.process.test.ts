import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ace/daemon";
import { Thread } from "@ace/protocol";
test("two ACP thread selections and effective support persist independently through ordinary events and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-acp-identity-"));
  const file = join(root, "events.sqlite");
  let store = new Store(file);
  try {
    const workspaceId = store.createWorkspace(root, "Synthetic");
    const threads = ["one", "two"].map((name) =>
      Thread.parse({
        id: name,
        workspaceId,
        title: name,
        provider: "acp",
        acpAgentId: `local:${name}`,
        installationId: `install-${name}`,
        instanceId: `home-${name}`,
        status: { state: "new" },
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    for (const thread of threads) {
      store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
      store.appendEvents(
        thread.id,
        [
          {
            type: "thread.updated",
            acpSupport: {
              capabilities: { resume: thread.id === "one", imageInput: false, planMode: false },
              mcp: "stdio",
              modelSelection: false,
              modeSelection: false,
              subagentSessions: false,
              coverage: "generic",
              visibility: "limited",
              raw: { json: "{}", truncated: false },
            },
          },
        ],
        2,
      );
      store.appendEvents(thread.id, [{ type: "thread.updated", title: "Renamed" }], 3);
    }
    store.close();
    store = new Store(file);
    for (const thread of threads) {
      expect(store.getThread(thread.id)).toMatchObject({
        acpAgentId: thread.acpAgentId,
        installationId: thread.installationId,
        instanceId: thread.instanceId,
        acpSupport: { visibility: "limited", capabilities: { resume: thread.id === "one" } },
      });
      expect(store.snapshotThread(thread.id).thread.instanceId).toBe(thread.instanceId);
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
