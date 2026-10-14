import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { opencodeNative } from "@ace/provider-kit/access-modes";
import { AgentCatalogInput, type AccessRequest, type ThreadId } from "@ace/protocol";
import { setup } from "./test-support.ts";
import { start, end } from "../engine/test-support.ts";
import { scriptedModelInstance, seedScriptedModels } from "../testing/models.ts";

/** An installed OpenCode whose turns finish at once, beside the harness's Codex and Claude. */
async function withOpenCode(h: ReturnType<typeof setup>) {
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
  await seedScriptedModels(h.catalog, scriptedModelInstance("opencode", h.home));
}

/** The owner's thread: OpenCode at the first-run default, then switched to Read-only. */
async function openCodeParentPendingReadOnly(h: ReturnType<typeof setup>) {
  await withOpenCode(h);
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
    h.service.command("switch-to-read-only", {
      type: "thread.permission.set",
      threadId,
      access: "read-only",
    }).ok,
  ).toBe(true);
  // OpenCode has no reviewer, so the first-run Auto review runs as the stricter Ask.
  expect(h.store.getThread(threadId)?.permission).toEqual({
    override: "read-only",
    effective: "ask",
    pending: true,
  });
  return h.caller(threadId);
}

const delegateTo = (
  provider: "claude" | "opencode",
  requestId: string,
  access?: AccessRequest,
  effort?: string,
) => ({
  requestId,
  task: "Take over the task",
  role: "helper",
  provider,
  model: "chosen-model",
  ...(access ? { access } : {}),
  ...(effort ? { effort } : {}),
  wait: false,
  estimatedLoad: 0,
});
function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

test("a Read-only parent's child runs Read-only on another provider, explicitly or inherited", async () => {
  const h = setup();
  const parent = await openCodeParentPendingReadOnly(h);
  const catalog = h.service.catalog(parent, AgentCatalogInput.parse({ provider: "claude" }));
  expect(catalog.caller.access).toBe("ask");
  expect(catalog.instances.flatMap((instance) => instance.allowedAccessModes)).toEqual([
    "read-only",
  ]);
  const explicit = h.service.delegate(parent, delegateTo("claude", "explicit", "read-only"));
  const inherited = h.service.delegate(parent, delegateTo("claude", "inherited"));
  await h.engine.flush();
  // Claude's native read-only mode is its plan mode.
  expect(h.contexts.get(explicit.childId)?.permissionMode).toBe("plan");
  expect(h.contexts.get(inherited.childId)?.permissionMode).toBe("plan");
  expect(h.store.listThreads()).toHaveLength(3);
});

test("a child broader than its parent is refused with the parent's mode and the allowed list", async () => {
  const h = setup();
  const parent = await openCodeParentPendingReadOnly(h);
  expect(
    refusal(() => h.service.delegate(parent, delegateTo("claude", "full", "full-access"))),
  ).toMatchObject({
    code: "access_escalation_denied",
    publicDetail: 'The parent thread runs in "read-only". Allowed claude access: "read-only".',
  });
  expect(h.store.listThreads()).toHaveLength(1);
});

test("an explicit mode the target doesn't support is refused with the modes it supports", async () => {
  const h = setup();
  await withOpenCode(h);
  const parent = await h.parent("full-access");
  expect(
    refusal(() => h.service.delegate(parent, delegateTo("opencode", "review", "auto-review"))),
  ).toMatchObject({
    code: "access_unavailable",
    publicDetail:
      'opencode supports "read-only", "ask", "full-access". Allowed under the parent: "read-only", "ask", "full-access".',
  });
  expect(h.store.listThreads()).toHaveLength(1);
});

test("an inherited mode the target lacks steps down to the nearest stricter one it supports", async () => {
  const h = setup();
  await withOpenCode(h);
  const parent = await h.parent("auto-review");
  const child = h.service.delegate(parent, delegateTo("opencode", "inherit"));
  await h.engine.flush();
  expect(h.store.getThread(child.childId)?.permission?.effective).toBe("ask");
  expect(h.contexts.get(child.childId)?.permissionMode).toBe(opencodeNative.ask);
});

test("a child's effort may exceed its parent's and names the model's native id", async () => {
  const h = setup();
  const parent = await h.parent("full-access");
  const child = h.service.delegate(parent, delegateTo("claude", "deep", undefined, "xhigh"));
  await h.engine.flush();
  expect(h.contexts.get(child.childId)?.options).toMatchObject({ effort: "extra-high" });
});

test("an effort the model doesn't offer is refused with the levels it does", async () => {
  const h = setup();
  const parent = await h.parent("full-access");
  expect(
    refusal(() => h.service.delegate(parent, delegateTo("claude", "max", undefined, "max"))),
  ).toMatchObject({
    code: "effort_unavailable",
    publicDetail: "chosen-model offers low, medium, high, xhigh.",
  });
  expect(h.store.listThreads()).toHaveLength(1);
});
