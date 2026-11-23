/*
 * Prototype for ADR 0217 (proposed): the task lanes of the Errands bot in `?fakeWorld=spade-lanes`,
 * as the app would read them from `GET /v1/conversations/{id}/tasks`. Fake data only; the seed
 * (`boot/fake-spade-lanes.ts`) stores each lane's conversation from the same list.
 */

export type LaneState = "working" | "human" | "done" | "failed" | "queued";

export interface LaneFixture {
  id: string;
  conversation: string;
  title: string;
  state: LaneState;
  /** The current plan step while it runs, or its report's first line once it has ended. */
  detail: string;
  done: number;
  total: number;
  startedMin: number;
  endedMin?: number;
  costMicros: number;
  /** Spade moved main's long work here (ADR 0217 §2a). */
  moved?: true;
  /** The goal and plan, as `GET /v1/agents/{id}/task` answers them. */
  task: unknown;
}

export const lanesBot = "errands";

const item = (
  id: string,
  text: string,
  status: "done" | "working" | "open" | "blocked",
  extra: Record<string, unknown> = {},
) => ({ id, text, status, verified: status === "done", split: false, ...extra });

export const lanes: readonly LaneFixture[] = [
  {
    id: "lane-flights",
    conversation: "c-lane-flights",
    title: "Book flights to Lisbon",
    state: "human",
    detail: "Wants to pay €412 on flytap.com",
    done: 3,
    total: 4,
    startedMin: 10,
    costMicros: 220_000,
    task: {
      goal: {
        id: "g-flights",
        title: "Book flights to Lisbon",
        text: "Also book flights to Lisbon, out on the 14th and back the 18th. Window seat.",
        criteria: [
          { id: "1", text: "Out on the 14th, back on the 18th" },
          { id: "2", text: "Window seats both ways" },
          { id: "3", text: "Booked, with the confirmation saved" },
        ],
        by: "bot",
      },
      items: [
        item("1", "Compare fares for the 14th and the 18th", "done", {
          evidence: [{ kind: "url", url: "https://www.flytap.com/en-us/flights" }],
        }),
        item("2", "Pick the cheapest with window seats", "done"),
        item("3", "Fill in the booking", "done"),
        item("4", "Pay and save the confirmation", "blocked", { reason: "Waits on your OK" }),
      ],
      progress: { state: "working" },
    },
  },
  {
    id: "lane-crm",
    conversation: "c-lane-crm",
    title: "Compare the three CRM quotes",
    state: "failed",
    detail: "Stopped early: HubSpot's pricing page wouldn't load",
    done: 2,
    total: 3,
    startedMin: 4,
    endedMin: 1,
    costMicros: 290_000,
    task: {
      goal: {
        id: "g-crm",
        title: "Compare the three CRM quotes",
        text: "And compare the three CRM quotes in /quotes.",
        criteria: [{ id: "1", text: "Pipedrive, Attio and HubSpot side by side in crm.md" }],
        by: "bot",
      },
      items: [
        item("1", "Read the Pipedrive and Attio quotes", "done", {
          evidence: [{ kind: "file", path: "quotes/pipedrive.pdf" }],
        }),
        item("2", "Put them side by side in crm.md", "done", {
          evidence: [{ kind: "file", path: "crm.md" }],
        }),
        item("3", "Check HubSpot's list prices", "blocked", {
          reason: "The pricing page didn't load after three tries",
        }),
      ],
      progress: { state: "working" },
    },
  },
  {
    id: "lane-invoice",
    conversation: "c-lane-invoice",
    title: "Fix the March invoice",
    state: "working",
    detail: "Drafting the email to Dana",
    done: 2,
    total: 5,
    startedMin: 12,
    costMicros: 380_000,
    task: {
      goal: {
        id: "g-invoice",
        title: "Fix the March invoice and send it to Dana",
        text: "The March invoice has the VAT line wrong. Fix it and send it to Dana once it's right.",
        criteria: [
          { id: "1", text: "VAT is 20% of the net total" },
          { id: "2", text: "The totals add up" },
          { id: "3", text: "Dana has the corrected invoice at dana@northwind.co" },
        ],
        by: "bot",
      },
      items: [
        item("1", "Find why the VAT line is wrong", "done", {
          evidence: [{ kind: "file", path: "invoices/2026-03.xlsx" }],
        }),
        item("2", "Correct VAT and the totals", "done", {
          evidence: [{ kind: "file", path: "invoices/2026-03.pdf" }],
        }),
        item("3", "Draft the email to Dana", "working"),
        item("4", "Send it to dana@northwind.co", "open"),
        item("5", "Save the sent copy", "open"),
      ],
      progress: { state: "working" },
    },
  },
  {
    id: "lane-quarterly",
    conversation: "c-lane-quarterly",
    title: "Draft the quarterly note",
    state: "working",
    detail: "Writing the revenue section",
    done: 3,
    total: 6,
    startedMin: 6,
    costMicros: 610_000,
    moved: true,
    task: {
      goal: {
        id: "g-quarterly",
        title: "Draft the quarterly note",
        text: "Draft the quarterly note from the numbers in Q3.xlsx.",
        criteria: [
          { id: "1", text: "Every number matches Q3.xlsx" },
          { id: "2", text: "One page, in the usual sections" },
        ],
        by: "bot",
      },
      items: [
        item("1", "Read Q3.xlsx", "done"),
        item("2", "Pull last quarter's note for the sections", "done"),
        item("3", "Outline the note", "done"),
        item("4", "Write the revenue section", "working"),
        item("5", "Write costs and hiring", "open"),
        item("6", "Check every number against the sheet", "open"),
      ],
      progress: { state: "working" },
    },
  },
  {
    id: "lane-drive",
    conversation: "c-lane-drive",
    title: "Clean up the shared drive",
    state: "done",
    detail: "214 files in six client folders; nothing deleted",
    done: 3,
    total: 3,
    startedMin: 5,
    endedMin: 2,
    costMicros: 170_000,
    task: {
      goal: {
        id: "g-drive",
        title: "Clean up the shared drive",
        text: "Clean up the shared drive: one folder per client.",
        criteria: [{ id: "1", text: "Every file is in its client's folder" }],
        by: "bot",
      },
      items: [
        item("1", "List every file and its client", "done"),
        item("2", "Move them into one folder per client", "done", {
          evidence: [{ kind: "file", path: "drive-moves.md" }],
        }),
        item("3", "Check nothing was left at the top", "done"),
      ],
      progress: { state: "done" },
    },
  },
];

/** The order the list shows (ADR 0217 §7): needs you, running, finished unseen, queued. */
const order: Record<LaneState, number> = { human: 0, failed: 1, working: 2, done: 3, queued: 4 };

export const lanesInOrder = (list: readonly LaneFixture[]) =>
  list.toSorted((a, b) => order[a.state] - order[b.state]);

export const laneLive = (lane: LaneFixture) => lane.state === "working" || lane.state === "human";

/** The pill's words: the live tasks, and how many need the person. */
export function lanesPillWords(list: readonly LaneFixture[]) {
  const live = list.filter(laneLive).length;
  const needs = list.filter((lane) => lane.state === "human").length;
  const tasks = `${live} ${live === 1 ? "task" : "tasks"}`;
  return needs ? `${tasks} · ${needs} needs you` : tasks;
}

export const lanesFor = (bot: string) => (bot === lanesBot ? lanes : undefined);

export const laneById = (id: string) => lanes.find((lane) => lane.id === id);

/** The quiet second line of a row: the step and count while it runs, else the report. */
export function laneDetail(lane: LaneFixture) {
  if (lane.state === "working" || lane.state === "human")
    return `${lane.done} of ${lane.total} · ${lane.detail}`;
  return lane.detail;
}

export const laneCost = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
