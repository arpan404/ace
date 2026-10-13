import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

const aceMcp = { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) };
const scripted = (mode = ":workspace") =>
  sessionHarness(false, "ace-mcp-approvals", undefined, undefined, aceMcp, mode);

async function turn(h: Awaited<ReturnType<typeof scripted>>, text: string) {
  const before = h.frames.filter((f) => obj(f.data).method === "turn/completed").length;
  await h.session.send([{ type: "text", text }], "queue");
  return () =>
    h.wait(() => h.frames.filter((f) => obj(f.data).method === "turn/completed").length > before);
}
const approvals = (h: Awaited<ReturnType<typeof scripted>>) =>
  Object.values(h.replay.state.interactions).filter((i) => i.request.kind === "approval");
const calls = (h: Awaited<ReturnType<typeof scripted>>, tool: string) =>
  Object.values(h.replay.state.items).filter(
    (item) =>
      item.type === "tool_call" &&
      item.call.detail.kind === "mcp" &&
      item.call.detail.tool === tool,
  );

test.each([
  [":danger-full-access", "ace_browser_navigate"],
  [":workspace", "ace_browser_navigate"],
  [":workspace", "ace_thread_read"],
  [":read-only", "ace_status"],
])("Codex in %s calls %s five times without asking the person", async (mode, tool) => {
  const h = await scripted(mode);
  try {
    const done = await turn(h, `call ${tool} 5`);
    await done();
    expect(calls(h, tool)).toHaveLength(5);
    expect(
      calls(h, tool).every((item) => item.type === "tool_call" && item.call.status === "succeeded"),
    ).toBe(true);
    expect(Object.values(h.replay.state.interactions)).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test("a destructive ace tool asks once when the person allows it for the thread", async () => {
  const h = await scripted();
  try {
    const done = await turn(h, "call ace_thread_merge 5");
    const first = await h.wait(() => approvals(h).some((i) => i.state === "pending"));
    expect(first).toBeTruthy();
    const [asked] = approvals(h);
    expect(asked?.request).toMatchObject({
      kind: "approval",
      mcpServer: { name: "ace" },
      target: { tool: "ace_thread_merge" },
      options: expect.arrayContaining([
        expect.objectContaining({ kind: "allow_session", label: "Allow for this thread" }),
      ]),
    });
    const key = Object.entries(h.replay.state.interactions).find(
      ([, interaction]) => interaction.id === asked?.id,
    )?.[0];
    await h.session.resolve(key ?? "", { kind: "approval", optionId: "accept_session" });
    await done();
    expect(approvals(h)).toHaveLength(1);
    expect(
      calls(h, "ace_thread_merge").filter(
        (item) => item.type === "tool_call" && item.call.status === "succeeded",
      ),
    ).toHaveLength(5);
  } finally {
    await h.dispose();
  }
});

test("allowing a destructive ace tool once asks again on its next call", async () => {
  const h = await scripted();
  try {
    const done = await turn(h, "call ace_thread_merge 2");
    for (const round of [1, 2]) {
      await h.wait(
        () =>
          approvals(h).filter((i) => i.state === "pending").length === 1 &&
          approvals(h).length === round,
      );
      const key = Object.entries(h.replay.state.interactions).find(
        ([, interaction]) => interaction.state === "pending",
      )?.[0];
      await h.session.resolve(key ?? "", { kind: "approval", optionId: "accept" });
    }
    await done();
    expect(approvals(h)).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});
