import { describe, expect, test } from "vitest";
import { FakeSpade } from "./spade.ts";
import { FakeSpadeApi } from "./spade-api.ts";
import { stageFakeLanes } from "./spade-lanes-stage.ts";

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
    // Main's long reply moved to a task closes with no words of its own.
    const moved = main.findIndex((event) => event.type === "reply_moved");
    expect(main.slice(moved + 1).find((event) => event.type === "reply_finished")).toMatchObject({
      reply: main[moved]?.reply,
      text: "",
    });
    const asked = main.find((event) => event.type === "approval_requested");
    expect(asked?.lane).toMatchObject({ title: "Book flights to Lisbon", call_id: "k1" });
    const reports = main.filter((event) => event.type === "worker_reported");
    expect(reports.map((report) => [report.kind, report.state])).toEqual([
      ["lane", "done"],
      ["lane", "failed"],
      ["lane", "needs_you"],
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

  test("a lane's goal and plan read like a bot's, and only a lane has one", async () => {
    const { bot, get } = staged();
    const lane = await get(`/v1/conversations/${bot.conversation}-lane-invoice/task`);
    expect(lane.status).toBe(200);
    const task = (lane.body as { task: { goal: { title: string }; items: { status: string }[] } })
      .task;
    expect(task.goal.title).toBe("Fix the March invoice and send it to Dana");
    expect(task.items.map((item) => item.status)).toEqual([
      "done",
      "done",
      "working",
      "open",
      "open",
    ]);
    expect((await get(`/v1/conversations/${bot.conversation}/task`)).status).toBe(404);
  });

  test("a lane's approval answered in main lets the lane work on, and Stop ends it alone", async () => {
    const { api, bot, get } = staged();
    const flights = `${bot.conversation}-lane-flights`;
    await api.answer({
      method: "POST",
      path: `/v1/conversations/${bot.conversation}/approvals/${flights}.k1`,
      body: JSON.stringify({ allowed: true, always: false }),
    });
    expect(api.eventsOf(flights).at(-1)).toMatchObject({
      type: "approval_answered",
      call_id: "k1",
      allowed: true,
    });
    await api.answer({ method: "POST", path: `/v1/conversations/${flights}/stop`, body: "" });
    const { body } = await get(`/v1/conversations/${bot.conversation}/tasks`);
    const tasks = (body as { tasks: { task: string; state: string }[] }).tasks;
    expect(tasks.find((task) => task.task === flights)?.state).toBe("stopped");
    expect(tasks.find((task) => task.task === `${bot.conversation}-lane-invoice`)?.state).toBe(
      "working",
    );
    expect(api.eventsOf(bot.conversation).at(-1)).toMatchObject({
      type: "worker_reported",
      kind: "lane",
      worker: flights,
      state: "stopped",
    });
  });
});
