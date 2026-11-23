import { parseSpadeAgentValue } from "@ace/ui-core/spade-chat";
import { expect, test } from "vitest";
import { spadeListRows } from "./spade-rows.ts";

function bot(fields: Record<string, unknown>) {
  const agent = parseSpadeAgentValue({ conversation: `c-${String(fields.id)}`, ...fields });
  if (!agent) throw new Error("Unreadable agent");
  return agent;
}

test("Spade lists its workers together with their own status and direct parent", () => {
  const spade = { id: "main", name: "Spade" };
  const scout = { id: "scout", name: "Pitch Scout" };
  const agents = [
    bot({ id: "unrelated", name: "Unrelated", state: "waiting" }),
    bot({ ...spade, kind: "main", state: "working", status: "1 worker working" }),
    bot({
      id: "followup",
      name: "Pitch Scout",
      parent: scout,
      state: "working",
      last_activity: 1,
      task_progress: { state: "working", items_total: 0, items_closed: 0, items_verified: 0 },
    }),
    bot({
      ...scout,
      parent: spade,
      state: "working",
      last_activity: 2,
      task_progress: { state: "working", items_total: 4, items_closed: 0, items_verified: 0 },
    }),
  ];

  const rows = spadeListRows(agents, [], "Mac", { bots: "answering", groups: "answering" });
  expect(
    rows.map(({ id, depth, familyRoot, parent, line }) => [id, depth, familyRoot, parent, line]),
  ).toEqual([
    ["main", 0, null, null, "Working"],
    ["scout", 1, "main", spade, "0 of 4 verified"],
    ["followup", 1, "main", scout, "Working on its goal"],
    ["unrelated", 0, null, null, "Needs you"],
  ]);
});
