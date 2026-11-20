import type { FakeSpadeApi } from "@ace/fake-daemon";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

/*
 * A packaged bot's panel (ADR 0200 §5.2) on the web: it opens beside the bot's conversation from
 * the header or a card's open action, in ace's sandboxed frame; the person's theme and the bot's
 * state cross in; only an action the panel declares, sent by its own frame, reaches the bot, and
 * as the page's, never the person's; one that needs the person waits on ace's own line, which a
 * script can't press; and a page that throws three times stops, saying so, until the person loads
 * it again.
 */

const page =
  "<!doctype html><html><head><title>Watched trips</title></head><body><ul></ul><script>addEventListener('ace:state', () => {});</script></body></html>";

function watcher(spade: FakeSpadeApi) {
  withEndpoint(spade);
  const bot = spade.addAgent({ id: "watcher", name: "Flight watcher" });
  spade.panels.set(bot, [
    {
      id: "watchlist",
      title: "Watched trips",
      html: page,
      actions: [
        { name: "stop_watching", label: "Stop watching" },
        { name: "book_fare", label: "Book this fare", confirm: true },
      ],
    },
  ]);
  spade.store(bot.conversation, { type: "user_message", text: "Watch KTM to DEL" });
  spade.showCard(bot, "card_1", 1, {
    title: "Fare dropped",
    blocks: [
      {
        kind: "actions",
        actions: [{ kind: "open_panel", label: "See all trips", panel: "watchlist" }],
      },
    ],
  });
}

const frameOf = async () => {
  const region = await screen.findByRole("region", { name: "Flight watcher: Watched trips" });
  return within(region).findByTitle<HTMLIFrameElement>("Watched trips");
};

/** What the app posted into the frame, by type. */
function posted(frame: HTMLIFrameElement) {
  const sent: { type?: string; [key: string]: unknown }[] = [];
  const target = frame.contentWindow;
  if (!target) throw new Error("no frame window");
  vi.spyOn(target, "postMessage").mockImplementation((message: unknown) => {
    sent.push(message as { type?: string });
  });
  return sent;
}

/** What the frame's outer document relays: a message's JSON text. */
const fromFrame = (frame: HTMLIFrameElement, message: unknown, origin = "null") =>
  rawFromFrame(frame, JSON.stringify(message), origin);
const rawFromFrame = (frame: HTMLIFrameElement, data: unknown, origin = "null") =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, source: frame.contentWindow, origin }),
    );
  });

test("opens beside the conversation from its header, with the theme and the bot's state", async () => {
  const { spade } = await spadeApp("/spade/watcher", watcher);
  await userEvent.click(await screen.findByRole("button", { name: "Watched trips" }));
  const frame = await frameOf();
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toMatch(/^data:text\/html/);
  const sent = posted(frame);
  fireEvent.load(frame);
  const init = sent.find((message) => message.type === "ace.panel.init");
  expect(init).toMatchObject({ runtime: "1", reduceMotion: false });
  expect(init?.["scheme"]).toMatch(/^(light|dark)$/);

  const bot = spade.agents.find((agent) => agent.id === "watcher");
  if (!bot) throw new Error("no bot");
  spade.panels.update(bot, "watchlist", { trips: [{ route: "KTM-DEL" }] });
  await waitFor(() =>
    expect(sent).toContainEqual({
      type: "ace.panel.state",
      data: { trips: [{ route: "KTM-DEL" }] },
    }),
  );
});

test("only a declared action from the panel's own frame reaches the bot, as the page's", async () => {
  const { spade } = await spadeApp("/spade/watcher?panel=watchlist", watcher);
  const frame = await frameOf();
  posted(frame);
  fireEvent.load(frame);
  const path = "/v1/conversations/c-watcher/panels/watchlist/actions";
  // Not declared, not typed, not text, too large, not from its frame: none of them is sent.
  fromFrame(frame, { type: "ace.panel.action", name: "book_it" });
  fromFrame(frame, { type: "ace.panel.call", tool: "send_message" });
  fromFrame(frame, { type: "ace.panel.action", name: "stop_watching", extra: 1 });
  rawFromFrame(frame, { type: "ace.panel.action", name: "stop_watching" });
  fromFrame(frame, { type: "ace.panel.action", name: "stop_watching", value: "€".repeat(6000) });
  fromFrame(frame, { type: "ace.panel.action", name: "stop_watching" }, location.origin);
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "ace.panel.action", name: "stop_watching" }),
        source: window,
        origin: "null",
      }),
    );
  });
  fromFrame(frame, { type: "ace.panel.action", name: "stop_watching", value: "KTM-DEL" });
  await waitFor(() =>
    expect(spade.sent("POST", path)).toEqual([
      expect.objectContaining({ action: "stop_watching", value: "KTM-DEL" }),
    ]),
  );
  // The page's, so never with the person's confirm.
  expect(spade.sent("POST", path)[0]).not.toHaveProperty("confirmed");
  const feed = within(screen.getByRole("feed", { name: "Conversation with Flight watcher" }));
  expect(await feed.findByText("Stop watching")).toBeTruthy();
  expect(feed.getByText(/The panel sent/)).toBeTruthy();
  expect(feed.queryByText(/You pressed/)).toBeNull();
});

test("an action only the person may send waits on ace's line, which a script can't press", async () => {
  const { spade } = await spadeApp("/spade/watcher?panel=watchlist", watcher);
  const frame = await frameOf();
  posted(frame);
  fireEvent.load(frame);
  const path = "/v1/conversations/c-watcher/panels/watchlist/actions";
  fromFrame(frame, { type: "ace.panel.action", name: "book_fare", value: "KTM-DEL" });
  const line = await screen.findByRole("group", { name: "Confirm the panel's action" });
  expect(
    within(line).getByText("Watched trips asks to send “Book this fare” with KTM-DEL."),
  ).toBeTruthy();
  // While it waits, the page can't swap what the person is about to confirm.
  fromFrame(frame, { type: "ace.panel.action", name: "book_fare", value: "LHR-JFK" });
  expect(within(line).queryByText(/LHR-JFK/)).toBeNull();
  // A click a script dispatches, long after the line appeared, is not the person's.
  await new Promise((resolve) => setTimeout(resolve, 700));
  act(() => within(line).getByRole("button", { name: "Confirm" }).click());
  await userEvent.click(within(line).getByRole("button", { name: "Confirm" }));
  expect(spade.sent("POST", path)).toEqual([]);
  // Cancel sends nothing, and the line goes.
  await userEvent.click(within(line).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Confirm the panel's action" })).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(spade.sent("POST", path)).toEqual([]);
  const feed = within(screen.getByRole("feed", { name: "Conversation with Flight watcher" }));
  expect(feed.queryByText("Book this fare")).toBeNull();
});

test("a page that throws three times is stopped until the person loads it again", async () => {
  await spadeApp("/spade/watcher?panel=watchlist", watcher);
  const frame = await frameOf();
  posted(frame);
  fireEvent.load(frame);
  fromFrame(frame, { type: "ace.panel.fault" });
  fromFrame(frame, { type: "ace.panel.fault" });
  expect(screen.queryByText("The panel stopped.")).toBeNull();
  fromFrame(frame, { type: "ace.panel.fault" });
  expect(await screen.findByText("The panel stopped.")).toBeTruthy();
  expect(screen.queryByTitle("Watched trips")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Load it again" }));
  expect(await frameOf()).toBeTruthy();
});

test("a card's open action opens the bot's panel", async () => {
  await spadeApp("/spade/watcher", watcher);
  const card = await screen.findByRole("region", { name: "Flight watcher: Fare dropped" });
  await userEvent.click(within(card).getByRole("button", { name: "See all trips" }));
  expect(await frameOf()).toBeTruthy();
});
