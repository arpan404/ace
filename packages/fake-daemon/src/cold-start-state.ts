import { CatalogEntry, CommandId, DeviceId, ThreadId } from "@ace/protocol";
import type { FakeDaemon } from "./daemon.ts";
import { rootAgent, message, turn, endTurn } from "./scenarios/facts.ts";
import { seedRealCatalogs } from "./scenarios/real-catalogs.ts";
import { seedRealThreadState } from "./real-thread-state.ts";

export const coldTdd = CatalogEntry.parse({
  id: "claude-tdd",
  name: "tdd",
  title: "Test Driven Development",
  kind: "skill",
  description: "Write the failing test first.",
  source: { provider: "claude", scope: "global" },
  invocation: { type: "skill", name: "tdd", path: "/fixture/tdd/SKILL.md" },
});
/** The observed legacy identities and failure shapes, with invented conversation text. */
export function seedColdStartState(daemon: FakeDaemon): void {
  seedRealCatalogs(daemon, 1);
  seedRealThreadState(daemon);
  daemon.services.accounts = daemon.services.accounts.filter(
    (account) => !["opencode", "pi"].includes(account.provider) || account.implicit,
  );
  for (const [id, title] of [
    ["cold-legacy", "Check the saved reply"],
    ["cold-unsent", "Fix the reconnect"],
    ["cold-untouched", "Start the first task"],
    ["cold-uncertain", "Review the retained message"],
  ]) {
    if (!id || !title) continue;
    daemon.createThread({ id, title, workspaceId: "relay", provider: "opencode" });
    if (id !== "cold-untouched") daemon.apply(id, [rootAgent("opencode")]);
  }
  daemon.apply("cold-legacy", [
    turn("root"),
    {
      type: "item.upsert",
      agent: "root",
      item: "old-answer",
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "I checked the reconnect path." }],
        complete: true,
        raw: [{ type: "projected.message", data: { id: "answer", type: "synthetic" } }],
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "replayed-answer",
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "I checked the reconnect path." }],
        complete: true,
        raw: [
          {
            type: "session.text.ended",
            data: { assistantMessageID: "answer", ordinal: 0, sessionID: "session" },
          },
        ],
      },
    },
    message("root", "text:session:other-answer:0", "assistant", "A separate reply stays visible."),
    ...["session.permissions", "session.instructions.updated"].map((text) => ({
      type: "item.upsert" as const,
      agent: "root",
      item: text,
      draft: { type: "notice" as const, level: "info" as const, text, complete: true },
    })),
    {
      type: "item.upsert",
      agent: "root",
      item: "system",
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "Internal tool schemas: bash, edit, read" }],
        raw: [{ type: "projected.message", data: { id: "system", type: "system" } }],
        complete: true,
      },
    },
    endTurn("root"),
  ]);
  daemon.updateThread("cold-unsent", {
    execution: { provider: "opencode", model: "muse-spark-1.3-contributor", options: {} },
  });
  daemon.holdQueue("cold-unsent", "model_unavailable");
  daemon.command({
    id: CommandId.parse("unsent-input"),
    deviceId: DeviceId.parse("fixture"),
    payload: {
      type: "thread.send",
      threadId: ThreadId.parse("cold-unsent"),
      input: [{ type: "text", text: "Which file needs fixing?" }],
      delivery: "queue",
    },
  });
  daemon.apply("cold-unsent", [
    {
      type: "item.upsert",
      agent: "root",
      item: "delivery",
      draft: {
        type: "notice",
        level: "error",
        code: "delivery_failed",
        commandId: CommandId.parse("unsent-input"),
        title: "Not sent",
        text: "Message not sent",
        detail: "opencode session opening failed: model_unavailable",
        complete: true,
      },
    },
  ]);
  daemon.holdQueue("cold-uncertain", "uncertain");
  for (const id of ["original-yo"]) {
    daemon.command({
      id: CommandId.parse(id),
      deviceId: DeviceId.parse("fixture"),
      payload: {
        type: "thread.send",
        threadId: ThreadId.parse("cold-uncertain"),
        input: [{ type: "text", text: "yo" }],
        delivery: "queue",
      },
    });
  }
  daemon.uncertainQueuedMessage("cold-uncertain", "original-yo");
  daemon.repeatQueuedInput("cold-uncertain", "original-yo");
  const status = daemon.services.providerStatuses.find((row) => row.provider === "opencode");
  if (status)
    Object.assign(status, {
      auth: "unknown",
      readiness: "needs_attention",
      authEvidence: "credentials_configured",
      authDetail: "2 services configured",
    });
  daemon.seedServices({ extensionCatalogs: { claude: [coldTdd], pi: [] } });
}
