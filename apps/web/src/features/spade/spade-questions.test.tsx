import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const path = "/v1/conversations/c-travel/questions/q1";

const seatAndNights = [
  {
    prompt: "Window or aisle?",
    kind: "choice",
    options: [{ label: "Window" }, { label: "Aisle", detail: "Easier to get out" }],
    other: true,
  },
  { prompt: "How many nights?", kind: "number", min: 1, max: 14, unit: "nights" },
];

function travel(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return api.addAgent({ id: "travel", name: "Travel" });
}

const card = async (name: string) =>
  within(
    await within(await screen.findByRole("feed", { name: "Conversation with Travel" })).findByRole(
      "group",
      { name },
    ),
  );

test("a card's questions are answered in place: a digit picks an option, then Send", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", seatAndNights),
  );
  const asked = await card("Travel asks 2 questions");
  // With focus on the options, a digit picks the option it names.
  asked.getByRole("radio", { name: "Window" }).focus();
  await userEvent.keyboard("2");
  expect(asked.getByRole("radio", { name: "Aisle" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.type(asked.getByRole("spinbutton", { name: "How many nights?" }), "3");
  expect(asked.getByText("nights")).toBeTruthy();
  await userEvent.click(asked.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ answers: ["Aisle", 3] }]));
  // Answered, the answers stand where the inputs were.
  expect(await asked.findByText("3 nights")).toBeTruthy();
  expect(asked.getByText("Aisle")).toBeTruthy();
  expect(asked.queryByRole("button", { name: "Send" })).toBeNull();
  expect(asked.queryByRole("spinbutton")).toBeNull();
});

test("Send says what a question still needs, and Spade's own refusal reads under the card", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", seatAndNights),
  );
  const asked = await card("Travel asks 2 questions");
  await userEvent.click(asked.getByRole("radio", { name: "Window" }));
  await userEvent.type(asked.getByRole("spinbutton", { name: "How many nights?" }), "20");
  await userEvent.click(asked.getByRole("button", { name: "Send" }));
  expect((await asked.findByRole("alert")).textContent).toBe("How many nights? At most 14.");
  expect(spade.sent("POST", path)).toEqual([]);

  const nights = asked.getByRole("spinbutton", { name: "How many nights?" });
  await userEvent.clear(nights);
  await userEvent.type(nights, "4");
  spade.refuseQuestion = { status: 400, error: "Question 1: Window is sold out." };
  await userEvent.click(asked.getByRole("button", { name: "Send" }));
  expect((await asked.findByRole("alert")).textContent).toBe("Question 1: Window is sold out.");
  // Refused, the card stays open with what the person put in.
  expect(asked.getByRole("button", { name: "Send" })).toBeTruthy();
});

test("checks count against the most a question takes", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", [
      {
        prompt: "Which meals?",
        kind: "choices",
        options: ["Breakfast", "Lunch", "Dinner"],
        max: 2,
      },
    ]),
  );
  const asked = await card("Travel asks: Which meals?");
  expect(asked.getByText("0 of 2 picked")).toBeTruthy();
  await userEvent.click(asked.getByRole("checkbox", { name: "Dinner" }));
  await userEvent.click(asked.getByRole("checkbox", { name: "Breakfast" }));
  expect(asked.getByText("2 of 2 picked")).toBeTruthy();
  await userEvent.click(asked.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(spade.sent("POST", path)).toEqual([{ answers: [["Breakfast", "Dinner"]] }]),
  );
});

test("a lone yes-or-no question is answered by Yes or No", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", [{ prompt: "Book the 9:40?", kind: "confirm" }]),
  );
  const asked = await card("Travel asks: Book the 9:40?");
  expect(asked.queryByRole("button", { name: "Send" })).toBeNull();
  await userEvent.click(asked.getByRole("button", { name: "Yes" }));
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ answers: [true] }]));
  expect(await asked.findByText("Answered")).toBeTruthy();
});

test("Answer later keeps the card's inputs, the header and the list count it, and it is answered any time", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", seatAndNights),
  );
  const asked = await card("Travel asks 2 questions");
  await userEvent.click(asked.getByRole("button", { name: "Answer later" }));
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ defer: true }]));
  expect(await asked.findByText("For later")).toBeTruthy();
  expect(asked.queryByRole("button", { name: "Answer later" })).toBeNull();

  const later = await screen.findByRole("button", { name: "1 question for later" });
  await userEvent.click(later);
  await waitFor(() => expect(document.activeElement?.getAttribute("data-question")).toBe("q1"));

  await userEvent.click(asked.getByRole("radio", { name: "Window" }));
  await userEvent.type(asked.getByRole("spinbutton", { name: "How many nights?" }), "2");
  await userEvent.click(asked.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(spade.sent("POST", path)).toEqual([{ defer: true }, { answers: ["Window", 2] }]),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /questions? for later/ })).toBeNull(),
  );
});

test("a card the bot asked without waiting shows on its list row, and Never mind dismisses it", async () => {
  const { spade } = await spadeApp("/spade", (api) =>
    api.card(travel(api), "q1", [{ prompt: "Which airport?", kind: "text" }], true),
  );
  await waitFor(async () =>
    expect((await botRow("Travel")).textContent).toMatch(/1 question for later$/),
  );
  await userEvent.click(await botRow("Travel"));
  const asked = await card("Travel asks: Which airport?");
  expect(asked.getByText("For later")).toBeTruthy();
  await userEvent.click(asked.getByRole("button", { name: "Never mind" }));
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ dismiss: true }]));
  expect(await asked.findByText("Dismissed")).toBeTruthy();
});

test("an older question with no kinds is one text card", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.question(travel(api), "q1", "Which airport?"),
  );
  const asked = await card("Travel asks: Which airport?");
  await userEvent.type(asked.getByRole("textbox", { name: "Which airport?" }), "Heathrow{Enter}");
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ answers: ["Heathrow"] }]));
});
