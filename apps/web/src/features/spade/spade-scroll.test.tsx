import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function garden(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const bot = spade.addAgent({ id: "garden", name: "Garden" });
  for (let at = 0; at < 6; at++) {
    spade.store(bot.conversation, { type: "user_message", text: `Question ${at}` });
    spade.reply(bot, `Answer ${at}`);
  }
  return bot;
}

/**
 * The conversation's scroller, given a tall page (jsdom lays nothing out): 2,000px of content in
 * a 500px window, wherever `scrollTop` puts it.
 */
async function tallScroller() {
  const feed = await screen.findByRole("feed", { name: "Conversation with Garden" });
  const scroller = feed.closest<HTMLElement>(".overflow-y-auto");
  if (!scroller) throw new Error("no scroller");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  return scroller;
}

function scrollTo(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

test("scrolled up, Scroll to end shows and takes the person back to the latest message", async () => {
  await spadeApp("/spade/garden", garden);
  const scroller = await tallScroller();
  scrollTo(scroller, 1500);
  expect(screen.queryByRole("button", { name: "Scroll to end" })).toBeNull();
  scrollTo(scroller, 200);
  await userEvent.click(await screen.findByRole("button", { name: "Scroll to end" }));
  expect(scroller.scrollTop).toBe(2000);
});

test("scrolled up, what arrives leaves the person where they are reading", async () => {
  let api: FakeSpadeApi | undefined;
  let bot: ReturnType<typeof garden> | undefined;
  await spadeApp("/spade/garden", (spade) => {
    api = spade;
    bot = garden(spade);
  });
  const scroller = await tallScroller();
  scrollTo(scroller, 200);
  if (api && bot) api.reply(bot, "A new answer while they read");
  await screen.findByText("A new answer while they read");
  expect(scroller.scrollTop).toBe(200);
});

test("a message sent while scrolled up takes the conversation to its end, where it shows", async () => {
  await spadeApp("/spade/garden", garden);
  const scroller = await tallScroller();
  scrollTo(scroller, 200);
  await screen.findByRole("button", { name: "Scroll to end" });
  await userEvent.type(
    screen.getByRole("combobox", { name: "Message Garden" }),
    "One more thing{Enter}",
  );
  await screen.findByText("One more thing");
  await waitFor(() => expect(scroller.scrollTop).toBe(2000));
});

test("a conversation opened again shows at once as it was left, without reading its history again", async () => {
  const { spade } = await spadeApp("/spade/garden", (api) => {
    garden(api);
    api.addAgent({ id: "weather", name: "Weather" });
  });
  within(await screen.findByRole("feed", { name: "Conversation with Garden" })).getByText(
    "Answer 5",
  );
  const reads = () => spade.sentPaths("GET", /^\/v1\/conversations\/c-garden\/events\?after=0/);
  expect(reads()).toHaveLength(1);
  await userEvent.click(await botRow("Weather"));
  await screen.findByRole("feed", { name: "Conversation with Weather" });
  await userEvent.click(await botRow("Garden"));
  // Back at once: its answers are there in the first frame, and its history wasn't read again.
  const feed = screen.getByRole("feed", { name: "Conversation with Garden" });
  expect(within(feed).getByText("Answer 5")).toBeTruthy();
  expect(reads()).toHaveLength(1);
});
