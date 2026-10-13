import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AccountRegistry, createInstance } from "@ace/accounts";
import { AgentControlOperation } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { scriptedModelInstance } from "../testing/models.ts";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { createConversationStarts } from "./conversations.ts";
import { setup } from "./test-support.ts";

const signal = () => new AbortController().signal;
const operation = (account?: string) =>
  AgentControlOperation.parse({
    op: "thread.start",
    requestId: "separate-chat",
    title: "Separate chat",
    text: "Hello from the parent agent",
    provider: "claude",
    model: "chosen-model",
    ...(account ? { accountId: account } : {}),
    workspace: { kind: "project" },
  });
const start = operation("claude-work");

type Harness = ReturnType<typeof setup>;
function port(h: Harness, runtime: WorkspaceRuntime) {
  return createAgentControlPort(h.store, h.service, {
    startConversation: createConversationStarts(
      { store: h.store, services: { workspaceActions: runtime }, signal: signal() },
      h.service,
      h.service.conversations,
    ),
  });
}
/** Threads the sidebar counts for the project: everything but untouched drafts. */
function listed(h: Harness, workspaceId: string): number {
  return (
    h.store.sidebarPage({ limit: 50 }).window.counts.find((row) => row.id === workspaceId)
      ?.threads ?? 0
  );
}
async function withAccount(h: Harness, accounts: AccountRegistry) {
  await accounts.register(
    createInstance({
      id: "claude-work",
      provider: "claude",
      label: "Work",
      homeDir: join(h.home, "claude-work"),
    }),
  );
  accounts.ingest("claude-work", {
    provider: "claude",
    payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
    observedAt: 1000,
    timeZone: "UTC",
  });
  h.catalog.registerInstance(scriptedModelInstance("claude", h.home, "claude-work"));
  await h.catalog.refresh({ instance: "claude-work" });
}

test("a conversation an agent starts is listed for the person at once, and ace's answer names it without ids", async () => {
  const accounts = new AccountRegistry(new DatabaseSync(":memory:"));
  const h = setup({}, undefined, false, undefined, false, accounts);
  await withAccount(h, accounts);
  const parent = await h.parent();
  const workspace = h.store.getThread(parent.threadId)?.workspaceId ?? "";
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  try {
    expect(listed(h, workspace)).toBe(1);
    const reply = await port(h, runtime).execute(parent, start, signal());
    const started = h.store.listThreads().find((row) => row.id !== parent.threadId);
    if (!started) throw new Error("Conversation missing");
    // Listed before its first turn has said anything: an agent's conversation is no draft.
    expect(listed(h, workspace)).toBe(2);
    expect(started).toMatchObject({ workspaceId: workspace, title: "Separate chat" });
    expect(reply).toMatchObject({
      ok: true,
      data: {
        threadId: started.id,
        title: "Separate chat",
        provider: "claude",
        model: "chosen-model",
        account: "Work",
      },
    });
    const summary = String(Reflect.get(Object(reply.data), "summary"));
    expect(summary).toContain("“Separate chat”");
    expect(summary).toContain("the Work account");
    expect(summary).not.toContain(started.id);
    expect(summary).not.toContain("claude-work");
    // A retried request answers the same way, for an agent that lost the first answer.
    expect(await port(h, runtime).execute(parent, start, signal())).toEqual(reply);
  } finally {
    await runtime.close();
    await h.close();
  }
});

test("a conversation started before ace listed agent conversations appears once the daemon reopens", async () => {
  const h = setup();
  const parent = await h.parent();
  const workspace = h.store.getThread(parent.threadId)?.workspaceId ?? "";
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  expect((await port(h, runtime).execute(parent, operation(), signal())).ok).toBe(true);
  const started = h.store.listThreads().find((row) => row.id !== parent.threadId);
  if (!started) throw new Error("Conversation missing");
  // What earlier daemons recorded: the conversation's opening message counted as no message.
  h.store.appendEvents(started.id, [
    { type: "thread.client.updated", changes: { hasSentMessage: false } },
  ]);
  expect(listed(h, workspace)).toBe(1);
  await runtime.close();
  await h.close();
  const reopened = setup({}, h.dbPath);
  const again = new WorkspaceRuntime(
    reopened.store,
    join(reopened.home, "owned"),
    reopened.clock.now,
  );
  try {
    port(reopened, again);
    expect(listed(reopened, workspace)).toBe(2);
  } finally {
    await again.close();
    await reopened.close();
  }
});
