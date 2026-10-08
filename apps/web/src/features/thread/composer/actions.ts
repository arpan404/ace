import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { runCommand } from "@/lib/daemon-command.ts";
import { latestForkPoint } from "../transitions/fork-point.ts";
import type { ThreadRef } from "../sources/index.ts";
export async function composerAction(
  action: string,
  ports: {
    client: ClientApi;
    thread: ThreadRef;
    attach(): void;
    files(): void;
    project(): void;
    model(): void;
    review(): void;
    fork(point: import("@ace/protocol").ForkPoint): void;
    insert(text: string): void;
    plan?: (() => void) | undefined;
  },
) {
  if (action === "attach") return ports.attach();
  if (action === "files") return ports.files();
  if (action === "project") return ports.project();
  if (action === "model") return ports.model();
  if (action === "goal") return ports.insert("Keep working toward this goal: ");
  if (action === "plan") {
    if (ports.plan) return ports.plan();
    if (ports.thread.draft)
      throw new Error("Choose plan mode in the approvals menu before sending.");
    await runCommand(ports.client, {
      type: "thread.permission.set",
      threadId: ThreadId.parse(ports.thread.id),
      permissionMode: "plan",
    });
    return;
  }
  if (ports.thread.draft) throw new Error("Send your first message before using this action.");
  if (action === "review") return ports.review();
  if (action === "fork") {
    const lease = ports.client.thread(ports.thread.id);
    try {
      const point = latestForkPoint(lease.store, lease.store.thread?.rootAgentId);
      if (!point) throw new Error("Wait for a finished reply before forking this thread.");
      return ports.fork(point);
    } finally {
      lease.release();
    }
  }
  if (action.startsWith("automation.run:")) {
    const reply = await ports.client.request({
      type: "automation.run",
      id: action.slice("automation.run:".length),
      variables: {},
    });
    if (!reply.ok) throw new Error("Couldn't run this workflow. Try again from Automations.");
    return;
  }
  throw new Error("This action isn't available here yet. Use the thread's work menu.");
}
