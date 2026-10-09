import type { FakeDaemon } from "@ace/fake-daemon";

/** Native shapes known to have broken the real app, without copying the owner's transcripts. */
export function fixtureSetup() {
  Object.assign(globalThis, {
    aceFakeWorld: "real-thread-state",
    aceFakeSetup(daemon: FakeDaemon) {
      daemon.createThread({
        id: "smoke-messy",
        title: "<recommended_plugins> Investigate saved history",
        provider: "claude",
        workspaceId: "relay",
      });
      daemon.seedServices({
        history: [
          {
            id: "smoke-history",
            instanceId: "claude-personal",
            provider: "claude",
            nativeId: "fixture-history",
            cwd: "/fake/relay",
            title: "Read a saved smoke session",
            lastActivity: 1,
            messageCount: 2,
            countAccuracy: "exact",
            support: { status: "supported" },
          },
        ],
        historyTranscripts: {
          "smoke-history": [
            { role: "user", text: "Inspect the saved state" },
            { role: "assistant", text: "The imported transcript stays in scratch" },
          ],
        },
        historyScan: {
          state: "ready",
          stats: { files: 1, reads: 1, bytes: 100, skipped: 0 },
          unsupported: [],
        },
      });
      daemon.apply("smoke-messy", [
        {
          type: "agent.seen",
          agent: "root",
          fidelity: "full",
          cwd: "/tmp/ace-smoke-fixture",
          native: { provider: "claude", nativeId: "synthetic" },
          origin: "root",
        },
        {
          type: "item.upsert",
          agent: "root",
          item: "person",
          draft: {
            type: "message",
            role: "user",
            parts: [{ type: "text", text: "Inspect an interrupted conversation" }],
            complete: true,
          },
        },
        {
          type: "item.upsert",
          agent: "root",
          item: "raw",
          draft: {
            type: "notice",
            level: "warning",
            text: "UNPREPARED OBJECT OMITTED",
            complete: true,
          },
        },
        {
          type: "item.upsert",
          agent: "root",
          item: "payload",
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: '{"type":"native.payload","data":{"unprepared":true}}' }],
            complete: true,
          },
        },
      ]);
    },
  });
}
