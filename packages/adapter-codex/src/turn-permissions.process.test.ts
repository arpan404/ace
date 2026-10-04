import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

for (const [initial, next] of [
  ["ask", "full-access"],
  ["full-access", "ask"],
] as const) {
  test(`old child and background approvals retain ${initial}; pre-ack root approvals use ${next}`, async () => {
    let mode: "ask" | "full-access" = initial;
    const h = await sessionHarness(false, "overlap-policy", undefined, undefined, undefined, mode, {
      getPermissionMode: async () => mode,
    });
    try {
      await h.session.send([{ type: "text", text: "first" }], "steer");
      await h.wait((f) => obj(f.data).method === "turn/completed");
      mode = next;
      await h.session.send([{ type: "text", text: "second" }], "steer");
      await h.wait(
        (f) =>
          obj(f.data).method === "item/commandExecution/requestApproval" &&
          obj(obj(f.data).params).itemId === "old-shell",
      );
      const approvals = Object.values(h.replay.state.interactions).filter(
        (i) =>
          i.request.kind === "approval" && i.raw.some((r) => r.type === "ace.permission-policy"),
      );
      const data = (raw: import("@ace/protocol").RawPayload | undefined) =>
        raw && "data" in raw ? obj(raw.data) : {};
      expect(
        approvals.map((i) => ({
          item: data(i.raw[0]).itemId,
          mode: data(i.raw.find((r) => r.type === "ace.permission-policy")).mode,
        })),
      ).toEqual([
        { item: "pre-ack", mode: next },
        { item: "child-approval", mode: initial },
        { item: "old-shell", mode: initial },
      ]);
      const applied = h.frames.filter(
        (f) => f.dir === "note" && obj(f.data).event === "permission-mode-applied",
      );
      const preAck = h.frames.findIndex(
        (f) =>
          obj(f.data).method === "item/commandExecution/requestApproval" &&
          obj(obj(f.data).params).itemId === "pre-ack",
      );
      expect(h.frames.findIndex((f) => f === applied[1])).toBeGreaterThan(preAck);
    } finally {
      await h.dispose();
    }
  });
}
