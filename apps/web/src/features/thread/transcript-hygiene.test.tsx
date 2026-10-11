import { facts, type Step } from "@ace/fake-daemon";
type Fact = Extract<Step, { kind: "facts" }>["facts"][number];
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { StepDetail } from "./items/step-detail.tsx";
import { MessageReferences } from "./items/message-references.tsx";
import { Item } from "@ace/protocol";
import { render } from "@testing-library/react";

import { preloadStepLabels } from "./items/step-labels.ts";
import { DeferredTurnRail, DeferredSearchBar } from "./deferred.ts";
beforeEach(async () => {
  localStorage.clear();
  await preloadStepLabels();
  await DeferredTurnRail.preload();
  await DeferredSearchBar.preload();
});

async function open(extra: Fact[] = []) {
  const app = harness();
  app.daemon.createThread({
    id: "hygiene",
    workspaceId: "ace",
    title: "Transcript hygiene",
    provider: "cursor",
  });
  app.daemon.apply("hygiene", [
    facts.rootAgent("cursor"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check the output"),
    ...extra,
  ]);
  await app.open("/t/hygiene");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText("Check the output");
  return { app, feed };
}

test("adapter evidence is hidden and a reviewed diagnostic uses plain copy", async () => {
  const { feed } = await open([
    {
      type: "item.upsert",
      agent: "root",
      item: "raw",
      draft: {
        type: "notice",
        level: "warning",
        text: "SDK positional UUID diagnostic",
        diagnostic: true,
        code: "cursor.diagnostic",
        complete: true,
      },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "stopped",
      draft: {
        type: "notice",
        level: "warning",
        text: "SDK host exited; unresolved child/background work is uncertain",
        diagnostic: true,
        code: "cursor.work-stopped",
        complete: true,
      },
    },
  ]);
  expect(
    await within(feed).findByText(
      "Cursor stopped; some work may not have finished. Send a message to continue.",
    ),
  ).toBeTruthy();
  expect(feed.textContent).not.toMatch(/SDK|UUID|uncertain|cursor\.work/);
});

test("live provider wrappers vanish while the person's words survive", async () => {
  const { feed } = await open([
    facts.message(
      "root",
      "wrapped",
      "user",
      "<system-reminder>private injected instruction</system-reminder>Fix the retry",
    ),
    {
      type: "item.upsert",
      agent: "root",
      item: "synthetic",
      draft: {
        type: "message",
        role: "user",
        synthetic: true,
        complete: true,
        parts: [
          { type: "text", text: "<system-reminder>private injected instruction</system-reminder>" },
        ],
      },
    },
  ]);
  expect(await within(feed).findByText("Fix the retry")).toBeTruthy();
  expect(feed.textContent).not.toMatch(/system-reminder|private injected/);
});

test("the live activity strip describes ace tools instead of showing native names", async () => {
  await open([
    {
      type: "item.upsert",
      agent: "root",
      item: "call",
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          kind: "mcp",
          title: "ace › ace_device_task_wait",
          status: "running",
          detail: {
            kind: "mcp",
            server: "ace",
            tool: "ace_device_task_wait",
            arguments: { taskId: "opaque-id" },
          },
          raw: [],
        },
      },
    },
  ]);
  await waitFor(() => expect(document.body.textContent).toContain("work on another device"));
  expect(document.body.textContent).not.toMatch(/ace_device|ace ›|opaque-id/);
});

test("a short transcript has no turn rail", async () => {
  await open([facts.endTurn("root")]);
  expect(screen.queryByRole("navigation", { name: "Conversation turns" })).toBeNull();
});

test("an overflowing two-turn transcript shows navigation", async () => {
  const { app, feed } = await open([
    facts.endTurn("root"),
    { type: "turn.started", agent: "root", nativeTurnId: "turn-2", trigger: "user" },
    facts.message("root", "ask-2", "user", "Another request"),
  ]);
  const viewport = feed.closest<HTMLElement>("[data-virtual-viewport]");
  if (!viewport) throw new Error("Missing transcript viewport");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 600 },
  });
  act(() =>
    app.daemon.apply("hygiene", [facts.message("root", "reply", "assistant", "More output")]),
  );
  expect(await screen.findByRole("navigation", { name: "Conversation turns" })).toBeTruthy();
});

test("an eight-turn transcript has simple accessible turn names", async () => {
  const extra: Fact[] = [facts.endTurn("root")];
  for (let n = 2; n <= 8; n++)
    extra.push(
      { type: "turn.started", agent: "root", nativeTurnId: `turn-${n}`, trigger: "user" },
      facts.message("root", `ask-${n}`, "user", `Request ${n}`),
      { type: "turn.ended", agent: "root", nativeTurnId: `turn-${n}`, outcome: "completed" },
    );
  await open(extra);
  const rail = await screen.findByRole("navigation", { name: "Conversation turns" });
  expect(within(rail).getByRole("button", { name: /^Turn 3$/ })).toBeTruthy();
  expect(within(rail).queryByRole("button", { name: "Turn 3: Turn 3" })).toBeNull();
});

test.each(["wheel", "PageUp", "ArrowUp"])(
  "upward %s intent preserves the reading position during new output",
  async (intent) => {
    const { app, feed } = await open();
    const viewport = feed.closest<HTMLElement>("[data-virtual-viewport]");
    if (!viewport) throw new Error("Missing transcript viewport");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 600 },
    });
    viewport.scrollTop = 390;
    fireEvent.scroll(viewport);
    if (intent === "wheel") fireEvent.wheel(viewport, { deltaY: -1 });
    else fireEvent.keyDown(viewport, { key: intent });
    act(() =>
      app.daemon.apply("hygiene", [
        facts.message("root", "reply", "assistant", "New streamed output"),
      ]),
    );
    await within(feed).findByText("New streamed output");
    expect(viewport.scrollTop).toBe(390);
  },
);

const tool = (detail: unknown) =>
  Item.parse({
    id: "item",
    agentId: "root",
    threadId: "thread",
    type: "tool_call",
    createdAt: 1,
    updatedAt: 1,
    complete: true,
    call: {
      id: "call",
      agentId: "root",
      startedAt: 1,
      kind: "mcp",
      title: "Native tool",
      status: "succeeded",
      detail,
      raw: [{ type: "native", data: { nativeId: "private-native-id" } }],
    },
  });

test("expanded MCP steps reveal raw identifiers and JSON only after Details", async () => {
  render(
    <StepDetail
      item={tool({
        kind: "mcp",
        server: "private-server",
        tool: "raw_tool",
        arguments: { internalKey: "secret-shape" },
      })}
    />,
  );
  expect(document.body.textContent).toBe("Details");
  await userEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(/private-server/)).toBeTruthy();
  expect(document.body.textContent).toContain("private-native-id");
  expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
});

test("shell output strips colour codes and OSC hyperlinks without losing text", async () => {
  const { feed } = await open([
    {
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: {
        type: "tool_call",
        complete: true,
        call: {
          kind: "shell",
          title: "printf output",
          status: "succeeded",
          detail: {
            kind: "shell",
            command: "printf output",
            output:
              "\u001b[32mgreen\u001b[0m \u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\\nnext",
          },
          raw: [],
        },
      },
    },
  ]);
  await userEvent.click(await within(feed).findByRole("button", { name: /^Work so far/ }));
  await userEvent.click(await within(feed).findByRole("button", { name: /Ran printf output/ }));
  expect((await within(feed).findByLabelText("Output")).textContent).toBe("green link\nnext");
});

test("closing transcript search clears the landed message's ring", async () => {
  const { feed } = await open([
    facts.message("root", "reply", "assistant", "The zebra review is ready."),
  ]);
  const user = userEvent.setup();
  await user.keyboard("{Meta>}f{/Meta}");
  const bar = await screen.findByRole("search", { name: "Search this thread" });
  await user.type(within(bar).getByRole("textbox", { name: "Search this thread" }), "zebra");
  await within(bar).findByText("1 result");
  await user.click(within(bar).getByRole("button", { name: "Next result" }));
  const landed = await within(feed).findByText("The zebra review is ready.");
  const article = landed.closest("[role=article]");
  if (!article) throw new Error("Missing landed message");
  const hasRing = () =>
    Array.from(article.querySelectorAll<HTMLElement>("div")).some(
      (element) => element.style.boxShadow,
    );
  await waitFor(() => expect(hasRing()).toBe(true));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(hasRing()).toBe(false));
});

test("cleaning an injected text part preserves spaces between the person's words", () => {
  const view = render(
    <MessageReferences
      parts={[
        { type: "text", text: "Read " },
        { type: "text", text: "<system-reminder>private</system-reminder>the file " },
        { type: "text", text: "please." },
      ]}
    />,
  );
  expect(view.container.textContent).toBe("Read the file please.");
});
