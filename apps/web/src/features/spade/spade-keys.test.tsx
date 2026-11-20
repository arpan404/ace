import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

/* A Spade conversation from the keyboard alone: the composer, a request and a card of questions. */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function travel(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "travel", name: "Travel" });
}

const composer = () => screen.getByRole("combobox", { name: "Message Travel" });

test("↑ in the empty composer brings back the person's last message, to change and send again", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) => {
    const bot = travel(api);
    api.store(bot.conversation, { type: "user_message", text: "Book the window seat" });
    api.reply(bot, "Done.");
    api.store(bot.conversation, { type: "user_message", text: "Lisbon on the 14th" });
    api.reply(bot, "Booked.");
  });
  await screen.findByText("Booked.");
  await userEvent.click(composer());
  await userEvent.keyboard("{ArrowUp}");
  await waitFor(() => expect(composer().textContent).toBe("Lisbon on the 14th"));
  await userEvent.keyboard("{ArrowUp}");
  await waitFor(() => expect(composer().textContent).toBe("Book the window seat"));
  await userEvent.keyboard(" please{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-travel/messages")).toEqual([
      expect.objectContaining({ text: "Book the window seat please" }),
    ]),
  );
});

test("Esc in the composer of a working bot only says so; a second Esc soon after stops it", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) => {
    const bot = travel(api);
    api.store(bot.conversation, { type: "user_message", text: "Find flights" });
    api.store(bot.conversation, { type: "reply_started", reply: "r1" });
  });
  await screen.findByRole("button", { name: "Stop the agent" });
  await userEvent.click(composer());
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByText("Esc again to stop Travel")).toBeTruthy();
  expect(spade.sent("POST", "/v1/conversations/c-travel/stop")).toEqual([]);
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-travel/stop")).toHaveLength(1),
  );
});

test("a request takes focus as it opens, so Enter allows it as its key says", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.ask(travel(api), "k1", "shell", { command: "ls ~/Downloads" }),
  );
  const request = await screen.findByRole("group", { name: /^Travel wants to/ });
  await waitFor(() => expect(document.activeElement).toBe(request));
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-travel/approvals/k1")).toEqual([
      { allowed: true, always: false },
    ]),
  );
});

test("a digit picks an option and takes focus with it, so Enter goes on to the next question", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", [
      {
        prompt: "Window or aisle?",
        kind: "choice",
        options: [{ label: "Window" }, { label: "Aisle" }],
      },
      { prompt: "Which airport?", kind: "text" },
    ]),
  );
  const card = within(await screen.findByRole("group", { name: "Travel asks 2 questions" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(card.getByRole("radio", { name: "Window" })),
  );
  await userEvent.keyboard("2");
  expect(document.activeElement).toBe(card.getByRole("radio", { name: "Aisle" }));
  await userEvent.keyboard("{Enter}");
  const airport = await card.findByRole("textbox", { name: "Which airport?" });
  await userEvent.type(airport, "LIS{Enter}");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-travel/questions/q1")).toEqual([
      { answers: ["Aisle", "LIS"] },
    ]),
  );
});
