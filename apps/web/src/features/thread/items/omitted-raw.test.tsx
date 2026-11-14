import { facts, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { componentClient } from "@/test/component-client.tsx";
import { ToolStep } from "./work-log-steps.tsx";

/** One finished browser step whose provider payloads only its Raw view shows. */
const scenario: Scenario = {
  thread: { id: "thread-raw", workspaceId: "relay", provider: "claude", title: "Raw" },
  steps: [
    {
      kind: "facts",
      facts: [
        facts.rootAgent("claude"),
        facts.turn("root"),
        {
          type: "item.upsert",
          agent: "root",
          item: "page",
          draft: {
            type: "tool_call",
            complete: true,
            call: {
              status: "succeeded",
              kind: "browser",
              title: "Opened the pricing page",
              detail: { kind: "browser" },
              // More than one page of the fake's `item.raw` (50 payloads).
              raw: Array.from({ length: 60 }, (_, index) => ({
                type: "browser_frame",
                data: { marker: index === 0 ? "frame-from-the-provider" : `frame-${index}` },
              })),
            },
          },
        },
        facts.endTurn("root"),
      ],
    },
  ],
};

test("a step's raw payloads left out of the transcript load when its Raw view opens, page by page", async () => {
  const app = await componentClient(scenario);
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-raw") });
  const itemId =
    view && "items" in view
      ? Object.values(view.items).find((item) => item.type === "tool_call")?.id
      : undefined;
  if (!itemId) throw new Error("The scenario has no step");
  app.render(
    <ul aria-label="Work log">
      <ToolStep threadId="thread-raw" itemId={itemId} />
    </ul>,
  );
  const log = within(await screen.findByRole("list", { name: "Work log" }));
  await userEvent.click(await log.findByRole("button", { name: /pricing page/ }));
  // The transcript arrived without the payloads: nothing of them shows until asked for.
  expect(log.queryByText(/frame-from-the-provider/)).toBeNull();
  await userEvent.click(await log.findByRole("button", { name: "Raw" }));
  expect(await log.findByText(/frame-from-the-provider/)).toBeTruthy();
  // The rest loads on asking, after what was read.
  expect(log.queryByText(/frame-59/)).toBeNull();
  await userEvent.click(log.getByRole("button", { name: "Show more" }));
  expect(await log.findByText(/frame-59/)).toBeTruthy();
  expect(log.getByText(/frame-from-the-provider/)).toBeTruthy();
  expect(log.queryByRole("button", { name: "Show more" })).toBeNull();
});

test("Raw opened on a running step reads again when the step finishes, and says it may change", async () => {
  const running: Scenario = {
    thread: { id: "thread-running", workspaceId: "relay", provider: "claude", title: "Running" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          {
            type: "item.upsert",
            agent: "root",
            item: "page",
            draft: {
              type: "tool_call",
              complete: false,
              call: {
                status: "running",
                kind: "browser",
                title: "Opening the pricing page",
                detail: { kind: "browser" },
                raw: [{ type: "browser_frame", data: { marker: "first-frame" } }],
              },
            },
          },
        ],
      },
    ],
  };
  const app = await componentClient(running);
  const threadId = ThreadId.parse("thread-running");
  const view = app.daemon.snapshot({ kind: "thread", threadId });
  const itemId =
    view && "items" in view
      ? Object.values(view.items).find((item) => item.type === "tool_call")?.id
      : undefined;
  if (!itemId) throw new Error("The scenario has no step");
  app.render(
    <ul aria-label="Work log">
      <ToolStep threadId="thread-running" itemId={itemId} />
    </ul>,
  );
  const log = within(await screen.findByRole("list", { name: "Work log" }));
  await userEvent.click(await log.findByRole("button", { name: /pricing page/ }));
  await userEvent.click(await log.findByRole("button", { name: "Raw" }));
  expect(await log.findByText(/first-frame/)).toBeTruthy();
  expect(log.getByText(/still running/i)).toBeTruthy();
  app.daemon.apply("thread-running", [
    {
      type: "item.upsert",
      agent: "root",
      item: "page",
      draft: {
        type: "tool_call",
        complete: true,
        call: {
          status: "succeeded",
          title: "Opened the pricing page",
          raw: [{ type: "browser_frame", data: { marker: "final-frame" } }],
        },
      },
    },
  ]);
  expect(await log.findByText(/final-frame/)).toBeTruthy();
  expect(log.queryByText(/still running/i)).toBeNull();
});

/** A running browser step whose payloads change as it goes; `final` ends it. */
function runningStep(id: string): Scenario {
  return {
    thread: { id, workspaceId: "relay", provider: "claude", title: "Running" },
    steps: [
      {
        kind: "facts",
        facts: [
          facts.rootAgent("claude"),
          facts.turn("root"),
          {
            type: "item.upsert",
            agent: "root",
            item: "page",
            draft: {
              type: "tool_call",
              complete: false,
              call: {
                status: "running",
                kind: "browser",
                title: "Opening the pricing page",
                detail: { kind: "browser" },
                raw: [{ type: "browser_frame", data: { marker: "first-frame" } }],
              },
            },
          },
        ],
      },
    ],
  };
}

const progress = (marker: string, done = false) => ({
  type: "item.upsert" as const,
  agent: "root",
  item: "page",
  draft: {
    type: "tool_call" as const,
    complete: done,
    call: {
      status: done ? ("succeeded" as const) : ("running" as const),
      title: done ? "Opened the pricing page" : "Opening the pricing page",
      raw: [{ type: "browser_frame", data: { marker } }],
    },
  },
});

/**
 * The step's Raw view, open, with `item.raw` replies held at the client until released: a
 * slow link. Counts the requests sent and the most in flight at once.
 */
async function heldRawView(id: string) {
  const app = await componentClient(runningStep(id));
  const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
  const itemId =
    view && "items" in view
      ? Object.values(view.items).find((item) => item.type === "tool_call")?.id
      : undefined;
  if (!itemId) throw new Error("The scenario has no step");
  const reads = { sent: 0, inFlight: 0, most: 0 };
  const held: (() => void)[] = [];
  let holding = true;
  const request = app.client.request.bind(app.client);
  Object.assign(app.client, {
    request: async (...args: Parameters<typeof request>) => {
      if (args[0].type !== "item.raw") return request(...args);
      reads.sent++;
      reads.inFlight++;
      reads.most = Math.max(reads.most, reads.inFlight);
      try {
        const answer = await request(...args);
        if (holding) await new Promise<void>((resolve) => held.push(resolve));
        return answer;
      } finally {
        reads.inFlight--;
      }
    },
  });
  app.render(
    <ul aria-label="Work log">
      <ToolStep threadId={id} itemId={itemId} />
    </ul>,
  );
  const log = within(await screen.findByRole("list", { name: "Work log" }));
  await userEvent.click(await log.findByRole("button", { name: /pricing page/ }));
  await userEvent.click(await log.findByRole("button", { name: "Raw" }));
  await vi.waitFor(() => expect(held).toHaveLength(1));
  return {
    app,
    log,
    reads,
    /** Let every held reply, and every later one, through. */
    release() {
      holding = false;
      for (const resolve of held.splice(0)) resolve();
    },
  };
}

test("a step that finishes while Raw's first read is still on its way is read again", async () => {
  const raw = await heldRawView("thread-slow-first");
  raw.app.daemon.apply("thread-slow-first", [progress("final-frame", true)]);
  raw.release();
  expect(await raw.log.findByText(/final-frame/)).toBeTruthy();
  expect(raw.log.queryByText(/still running/i)).toBeNull();
});

test("a burst of updates during a slow read makes one follow-up, never a queue of reads", async () => {
  const raw = await heldRawView("thread-burst");
  for (const marker of ["frame-a", "frame-b", "frame-c", "frame-d", "frame-e"])
    raw.app.daemon.apply("thread-burst", [progress(marker)]);
  raw.app.daemon.apply("thread-burst", [progress("final-frame", true)]);
  // Give a would-be queue of reads every chance to start.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(raw.reads.sent).toBe(1);
  raw.release();
  expect(await raw.log.findByText(/final-frame/)).toBeTruthy();
  expect(raw.reads).toMatchObject({ sent: 2, most: 1 });
});
