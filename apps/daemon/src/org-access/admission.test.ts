import { describe, expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { mcpAdmission } from "./mcp-operations.ts";
import { Handles, runIfStillAllowed } from "./handles.ts";
import { structuralTrees } from "./trees.ts";

const t = (id: string) => ThreadId.parse(id);
const caller = (threadId: string, sessionId = "s_1") => ({ sessionId, threadId, agentId: "a_1" });
const trees = structuralTrees((thread) => (thread === t("t_child") ? t("t_root") : undefined));

describe("ace MCP calls on an org host", () => {
  const onOrgHost = mcpAdmission({ org: () => "org_acme", trees });
  const onPersonal = mcpAdmission({ org: () => undefined, trees });

  it("lets an agent act in its own tree, its children included", () => {
    expect(onOrgHost("agent_message", {}, caller("t_child"))).toBe(true);
    expect(onOrgHost("thread_read", { threadId: "t_root" }, caller("t_child"))).toBe(true);
    expect(onOrgHost("delegate", { task: "x" }, caller("t_root"))).toBe(true);
  });

  it("refuses another tree, a list across trees, and tools nobody classified", () => {
    expect(onOrgHost("thread_read", { threadId: "t_other" }, caller("t_root"))).toBe(false);
    expect(onOrgHost("thread_control", { threadId: "t_other" }, caller("t_root"))).toBe(false);
    expect(onOrgHost("threads_find", {}, caller("t_root"))).toBe(false);
    expect(onOrgHost("thread_start", {}, caller("t_root"))).toBe(false);
    expect(onOrgHost("screen_act", {}, caller("t_root"))).toBe(false);
    expect(onOrgHost("machines", {}, caller("t_root"))).toBe(false);
    expect(onOrgHost("transfer", {}, caller("t_root"))).toBe(false);
    expect(onOrgHost("a_tool_added_later", {}, caller("t_root"))).toBe(false);
  });

  it("leaves Spade's own lease and a person's machine as they were", () => {
    expect(onOrgHost("screen_act", {}, caller("t_spade", "spade:grant_1"))).toBe(true);
    expect(onPersonal("thread_read", { threadId: "t_other" }, caller("t_root"))).toBe(true);
    expect(onPersonal("a_tool_added_later", {}, caller("t_root"))).toBe(true);
  });
});

describe("live handles and queued effects", () => {
  it("closes the handles their holder may no longer have, and keeps the rest", () => {
    const handles = new Handles();
    const closed: string[] = [];
    let lost = false;
    handles.bind({
      operation: "tree.read",
      resource: { kind: "tree", ref: { root: t("t_a") } },
      close: (reason) => closed.push(`a:${reason}`),
    });
    handles.bind({
      operation: "host.meta",
      resource: { kind: "host" },
      close: (reason) => closed.push(`b:${reason}`),
    });
    const decide = (operation: string) =>
      lost && operation === "tree.read"
        ? ({ allowed: false, reason: "not_shared" } as const)
        : ({ allowed: true } as const);
    expect(handles.revalidate(decide)).toBe(0);
    lost = true;
    expect(handles.revalidate(decide)).toBe(1);
    expect(closed).toEqual(["a:not_shared"]);
    // Closed once: a second pass finds nothing left to close.
    expect(handles.revalidate(decide)).toBe(0);
  });

  it("drops a queued effect whose access was lost before it runs, and says why", async () => {
    const dropped: string[] = [];
    let ran = 0;
    const effect = {
      operation: "tree.write" as const,
      resource: { kind: "tree" as const, ref: { root: t("t_a") } },
      run: () => ++ran,
    };
    await runIfStillAllowed(
      effect,
      () => ({ allowed: true }),
      (why) => dropped.push(why),
    );
    await runIfStillAllowed(
      effect,
      () => ({ allowed: false, reason: "not_owner" }),
      (why) => dropped.push(why),
    );
    expect(ran).toBe(1);
    expect(dropped).toEqual(["not_owner"]);
  });
});
