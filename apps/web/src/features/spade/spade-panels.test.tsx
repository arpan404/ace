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
 * state cross in; only an action the panel declares, sent by its own frame, reaches the bot; and
 * a page that throws three times stops, saying so, until the person loads it again.
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
      actions: [{ name: "stop_watching", label: "Stop watching" }],
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

const fromFrame = (frame: HTMLIFrameElement, data: unknown, origin = "null") =>
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

test("only a declared action from the panel's own frame reaches the bot, as the person's", async () => {
  const { spade } = await spadeApp("/spade/watcher?panel=watchlist", watcher);
  const frame = await frameOf();
  posted(frame);
  fireEvent.load(frame);
  const path = "/v1/conversations/c-watcher/panels/watchlist/actions";
  // Not declared, not typed, not from its frame: none of them is sent.
  fromFrame(frame, { type: "ace.panel.action", name: "book_it" });
  fromFrame(frame, { type: "ace.panel.call", tool: "send_message" });
  fromFrame(frame, { type: "ace.panel.action", name: "stop_watching", extra: 1 });
  fromFrame(frame, { type: "ace.panel.action", name: "stop_watching" }, location.origin);
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "ace.panel.action", name: "stop_watching" },
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
  const feed = within(screen.getByRole("feed", { name: "Conversation with Flight watcher" }));
  expect(await feed.findByText("Stop watching")).toBeTruthy();
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
