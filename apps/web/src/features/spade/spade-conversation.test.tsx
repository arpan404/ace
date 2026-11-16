import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function garden(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "garden", name: "Garden" });
}

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });
const header = () => screen.getByRole("banner");

test("the pill names the bot over its conversation and opens its profile, with nothing else in the bar but its actions", async () => {
  await spadeApp("/spade/garden", garden);
  await feed("Garden");
  // The bar names nothing and holds no ⋯: the pill names the bot.
  expect(within(header()).queryByText("Garden")).toBeNull();
  expect(within(header()).queryByRole("button", { name: "More actions" })).toBeNull();
  expect(within(header()).getByRole("button", { name: "Open Garden's profile" })).toBeTruthy();
  // On this machine the pill says nothing of where the bot runs.
  expect(screen.getByRole("button", { name: "Garden: open its profile" })).toBeTruthy();
  await openProfile("Garden");
  // The profile holds what acts on the bot; the bar above it holds only Share and close.
  const profile = within(await screen.findByRole("region", { name: "Garden's profile" }));
  expect(await profile.findByRole("button", { name: "Delete bot…" })).toBeTruthy();
  expect(within(header()).getByRole("button", { name: "Share Garden" })).toBeTruthy();
  expect(within(header()).getByRole("button", { name: "Close profile" })).toBeTruthy();
  expect(within(header()).queryByRole("button", { name: "Open Garden's profile" })).toBeNull();
});

test("a bot on another machine says where in its pill", async () => {
  await spadeApp("/spade?on=studio", withEndpoint, {
    machines: [
      {
        hostId: "studio",
        name: "Studio Mac",
        seed: (api) => {
          withEndpoint(api);
          api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
          api.addAgent({ id: "scout", name: "Scout" });
        },
      },
    ],
  });
  await screen.findByRole("link", { name: /^Scout/ }).then((row) => userEvent.click(row));
  await feed("Scout");
  expect(
    await screen.findByRole("button", { name: "Scout on Studio Mac: open its profile" }),
  ).toBeTruthy();
});

test("a bot waiting on its card is not working: the composer offers no Stop", async () => {
  await spadeApp("/spade/garden", (api) =>
    api.card(garden(api), "q1", [{ prompt: "Which bed?", kind: "text" }]),
  );
  const chat = within(await feed("Garden"));
  await chat.findByRole("group", { name: /^Garden asks/ });
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(screen.getByRole("button", { name: "Talk with Garden" })).toBeTruthy();
});

test("a working bot's composer offers Stop until the person types, then Send", async () => {
  await spadeApp("/spade/garden", (api) => {
    const c = garden(api).conversation;
    api.store(c, { type: "user_message", text: "Water the beds" });
    api.store(c, { type: "reply_started", reply: "r1" });
  });
  await feed("Garden");
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
  await userEvent.type(screen.getByRole("combobox", { name: "Message Garden" }), "and the pots");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull());
});

test("an idle bot's empty composer draws voice off, saying it is coming, and Send once there are words", async () => {
  await spadeApp("/spade/garden", garden);
  await feed("Garden");
  const voice = await screen.findByRole("button", { name: "Talk with Garden" });
  expect(voice.getAttribute("aria-disabled")).toBe("true");
  await userEvent.hover(voice);
  expect(await screen.findByText("Voice is coming")).toBeTruthy();
  await userEvent.type(screen.getByRole("combobox", { name: "Message Garden" }), "hello");
  expect(await screen.findByRole("button", { name: /^(Send|Steer message)$/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Talk with Garden" })).toBeNull();
});
