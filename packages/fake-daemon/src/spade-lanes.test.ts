import { describe, expect, test } from "vitest";
import { FakeSpade } from "./spade.ts";
import { FakeSpadeApi } from "./spade-api.ts";
import { stageFakeLanes } from "./spade-lanes.ts";

function staged() {
  const spade = new FakeSpade();
  spade.setStatus({ state: "ready" } as FakeSpade["status"]);
  const api = new FakeSpadeApi(spade, () => 1_000_000);
  const bot = api.addAgent({ name: "Errands" });
  const host = {
    store: (conversation: string, event: Record<string, unknown>) => api.store(conversation, event),
    events: (conversation: string) => api.eventsOf(conversation),
    now: () => 1_000_000,
  };
  stageFakeLanes(api.lanes, host, bot.conversation);
  const get = async (path: string) => {
    const answer = await api.answer({ method: "GET", path, body: undefined });
    return { status: answer.status, body: JSON.parse(answer.body ?? "null") as unknown };
  };
  return { api, bot, get };
}

describe("a bot's task lanes in the fake API", () => {
  test("list in the task list's order: needs you, running, ended, queued", async () => {
    const { bot, get } = staged();
    const { status, body } = await get(`/v1/conversations/${bot.conversation}/tasks`);
    expect(status).toBe(200);
    const tasks = (body as { tasks: { title: string; state: string }[] }).tasks;
    expect(tasks.map((task) => [task.title, task.state])).toEqual([
      ["Book flights to Lisbon", "needs_you"],
      ["Fix the March invoice", "working"],
      ["Draft the quarterly note", "working"],
      ["Compare the three CRM quotes", "failed"],
      ["Clean up the shared drive", "done"],
      ["Renew the domain", "queued"],
    ]);
  });

  test("main holds each lane's line, its report, and its request naming the lane", () => {
    const { api, bot } = staged();
    const main = api.eventsOf(bot.conversation);
    const types = main.map((event) => event.type);
    expect(types.filter((type) => type === "lane_started")).toHaveLength(6);
    expect(types).toContain("reply_moved");
    const asked = main.find((event) => event.type === "approval_requested");
    expect(asked?.lane).toMatchObject({ title: "Book flights to Lisbon", call_id: "k1" });
    const reports = main.filter((event) => event.type === "worker_reported");
    expect(reports.map((report) => [report.kind, report.state])).toEqual([
      ["lane", "failed"],
      ["lane", "done"],
    ]);
  });

  test("each lane is a conversation of its own, starting with its link to main", async () => {
    const { bot, get } = staged();
    const { body } = await get(`/v1/conversations/${bot.conversation}-lane-invoice/events`);
    const events = body as { event: Record<string, unknown> }[];
    expect(events[0]?.event).toMatchObject({
      type: "lane_of",
      parent_conversation: bot.conversation,
      title: "Fix the March invoice",
    });
    expect(events[1]?.event).toMatchObject({ type: "user_message" });
  });
});
