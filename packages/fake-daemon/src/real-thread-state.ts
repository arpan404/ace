import { CatalogModel, CommandId, DeviceId, ThreadId, PortableHandoff } from "@ace/protocol";
import type { FakeDaemon } from "./daemon.ts";
import { rootAgent, turn, endTurn, message } from "./scenarios/facts.ts";

/** Synthetic equivalents of the owner's legacy shapes. No personal history is copied. */
export const legacyHandoff = JSON.stringify(
  PortableHandoff.parse({
    version: 1,
    sourceThreadId: "earlier-thread",
    throughSeq: 10,
    lossy: true,
    policy: "recent-complete-items",
    excerpts: [],
    omittedItems: 0,
    history: { type: "items.page", threadId: "earlier-thread", before: 11, limit: 50 },
    limitations:
      "Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments.",
  }),
);

export function seedRealThreadState(daemon: FakeDaemon): void {
  const deviceId = DeviceId.parse("fixture-person");
  const baseModel = daemon.services.models.find((model) => model.provider === "opencode");
  if (
    baseModel &&
    !daemon.services.models.some((model) => model.id === "opencode-go/muse-spark-1.3-contributor")
  )
    daemon.services.models.push(
      CatalogModel.parse({
        ...baseModel,
        id: "opencode-go/muse-spark-1.3-contributor",
        nativeModelId: "opencode-go/muse-spark-1.3-contributor",
        nativeProviderId: "opencode-go",
        displayName: "Muse Spark 1.3 Contributor",
        hidden: false,
        deprecated: false,
        legacy: false,
      }),
    );
  for (const [id, title] of [
    ["legacy-notices", "Check the reconnect path"],
    ["legacy-handoff", "Continue the previous task"],
    ["legacy-model", "Fix the model selection"],
    ["legacy-restart", "Finish the background build"],
    ["legacy-send", "Check the saved message"],
  ]) {
    if (!id || !title) continue;
    daemon.createThread({ id, title, workspaceId: "relay", provider: "opencode" });
    daemon.apply(id, [
      rootAgent("opencode"),
      turn("root"),
      message("root", "first", "user", title),
      message(
        "root",
        "answer",
        "assistant",
        "I checked the saved conversation and kept its original messages.",
      ),
      endTurn("root"),
    ]);
  }
  daemon.apply("legacy-notices", [
    {
      type: "item.upsert",
      agent: "root",
      item: "stderr",
      draft: {
        type: "notice",
        level: "error",
        text: "\u001b[31mINTERNAL STDERR\u001b[0m",
        raw: [{ type: "stderr", data: {} }],
        complete: true,
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "permissions",
      draft: {
        type: "notice",
        level: "info",
        text: "session.permissions",
        raw: [{ type: "native-notice", data: {} }],
        complete: true,
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "timeout",
      draft: {
        type: "notice",
        level: "warning",
        text: "\u001b[2mthread.resume: The connection timed out. Try again.\u001b[0m",
        complete: true,
      },
    },
  ]);
  daemon.apply("legacy-model", [
    {
      type: "item.upsert",
      agent: "root",
      item: "model-error",
      draft: {
        type: "notice",
        level: "error",
        text: "opencode session opening failed: model_unavailable",
        complete: true,
      },
    },
  ]);
  daemon.apply("legacy-handoff", [message("root", "portable-echo", "user", `${legacyHandoff}hi`)]);
  daemon.apply("legacy-send", [
    message("root", "input:queued-legacy-send", "user", "Please continue from this message"),
    {
      type: "item.upsert",
      agent: "root",
      item: "delivery",
      draft: {
        type: "notice",
        level: "error",
        code: "delivery_failed",
        commandId: CommandId.parse("queued-legacy-send"),
        text: "thread.send: The connection closed. Retry this message.",
        complete: true,
      },
    },
  ]);
  daemon.updateThread("legacy-model", {
    execution: { provider: "opencode", model: "muse-spark-1.3-contributor", options: {} },
  });
  for (const [id, reason] of [
    ["legacy-model", "model_unavailable"],
    ["legacy-restart", "restart"],
    ["legacy-send", "not_sent"],
  ] as const) {
    daemon.holdQueue(id, reason);
    daemon.command({
      id: CommandId.parse(`queued-${id}`),
      deviceId,
      payload: {
        type: "thread.send",
        threadId: ThreadId.parse(id),
        input: [{ type: "text", text: "Please continue from this message" }],
        delivery: "queue",
      },
    });
  }
}
