import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { AgentCatalogInput, type ThreadId } from "@ace/protocol";
import { setup } from "./test-support.ts";
import { start, end } from "../engine/test-support.ts";

/** An installed OpenCode whose turns finish at once, beside the harness's Codex and Claude. */
function withOpenCode(h: ReturnType<typeof setup>) {
  const adapter = createScriptedAdapter({
    provider: "opencode",
    capabilities: {
      ...h.registry.get("claude").capabilities,
      permissionModes: nativePermissionModes("opencode"),
    },
    createTranslator: () => ({ translate: h.frames.translate, tick: () => [] }),
    steps: Array.from({ length: 4 }, () => ({
      on: "send" as const,
      frames: [h.frames.frame(start, end)],
    })),
  });
  h.registry.register(
    {
      ...adapter,
      openSession: (context) => {
        h.contexts.set(context.threadId, context);
        return adapter.openSession(context);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
}

/** The owner's thread: OpenCode at its default, then switched to Plan while it ran. */
async function openCodeParentPendingPlan(h: ReturnType<typeof setup>) {
  withOpenCode(h);
  await h.catalog.refresh();
  const created = h.service.command("opencode-parent", {
    type: "thread.create",
    provider: "opencode",
    workspaceId: h.store.createWorkspace(h.home, "project"),
    input: [{ type: "text", text: "Plan the work" }],
  });
  if (!created.ok || !created.threadId) throw new Error(`Parent missing: ${created.error}`);
  await h.engine.flush();
  const threadId: ThreadId = created.threadId;
  expect(
    h.service.command("switch-to-plan", {
      type: "thread.permission.set",
      threadId,
      permissionMode: "plan",
    }).ok,
  ).toBe(true);
  expect(h.store.getThread(threadId)?.permission).toEqual({
    override: "plan",
    effective: null,
    pending: true,
  });
  return h.caller(threadId);
}

const toClaude = (requestId: string, permissionMode?: string) => ({
  requestId,
  task: "Take over the task",
  role: "helper",
  provider: "claude" as const,
  model: "chosen-model",
  ...(permissionMode ? { permissionMode } : {}),
  wait: false,
  estimatedLoad: 0,
});

test("an OpenCode parent with Plan pending delegates to Claude in plan, explicitly or inherited", async () => {
  const h = setup();
  const parent = await openCodeParentPendingPlan(h);
  const catalog = h.service.catalog(parent, AgentCatalogInput.parse({ provider: "claude" }));
  expect(catalog.instances.flatMap((instance) => instance.allowedPermissionModes)).toEqual([
    expect.objectContaining({ id: "plan" }),
  ]);
  expect(catalog.instances.every((instance) => instance.allowedDefault)).toBe(true);
  const explicit = h.service.delegate(parent, toClaude("explicit", "plan"));
  const inherited = h.service.delegate(parent, toClaude("inherited"));
  await h.engine.flush();
  expect(h.contexts.get(explicit.childId)?.permissionMode).toBe("plan");
  expect(h.contexts.get(inherited.childId)?.permissionMode).toBe("plan");
  expect(h.store.listThreads()).toHaveLength(3);
});

test("a bypass child under a Plan parent is refused with the parent's mode and the allowed modes", async () => {
  const h = setup();
  const parent = await openCodeParentPendingPlan(h);
  let refusal: unknown;
  try {
    h.service.delegate(parent, toClaude("bypass", "bypassPermissions"));
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({
    code: "delegation_denied",
    publicDetail: 'The parent thread runs opencode in "plan". Allowed claude modes: "plan".',
  });
  expect(h.store.listThreads()).toHaveLength(1);
});
