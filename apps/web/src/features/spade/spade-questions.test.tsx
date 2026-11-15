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

/** The card `name` once it reads `text`: an answered or folded card is drawn anew. */
const cardWith = async (name: string, text: string) => {
  await waitFor(async () => expect((await card(name)).getByText(text)).toBeTruthy());
  return card(name);
};

test("a card shows one question at a time: a digit picks, Next keeps the answer, and Send sends them all", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", seatAndNights),
  );
  const asked = await card("Travel asks 2 questions");
  expect(asked.getByLabelText("Question 1 of 2")).toBeTruthy();
  expect(asked.queryByRole("spinbutton")).toBeNull();
  expect(asked.queryByRole("button", { name: "Send" })).toBeNull();
  // With focus on the options, a digit picks the option it names.
  asked.getByRole("radio", { name: "Window" }).focus();
  await userEvent.keyboard("2");
  expect(asked.getByRole("radio", { name: "Aisle" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(asked.getByRole("button", { name: "Next" }));
  await userEvent.type(asked.getByRole("spinbutton", { name: "How many nights?" }), "3");
  expect(asked.getByText("nights")).toBeTruthy();
  // Back and forth, each answer stays.
  await userEvent.click(asked.getByRole("button", { name: "Previous question" }));
  expect(asked.getByRole("radio", { name: "Aisle" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(asked.getByRole("button", { name: "Next question" }));
  expect(
    (asked.getByRole("spinbutton", { name: "How many nights?" }) as HTMLInputElement).value,
  ).toBe("3");
  await userEvent.click(asked.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ answers: ["Aisle", 3] }]));
  // Answered, each question stays the bot's and each answer becomes the person's own bubble.
  const settled = await cardWith("Travel asks 2 questions", "3 nights");
  expect(settled.getByText("Window or aisle?")).toBeTruthy();
  expect(settled.getAllByRole("article", { name: "You" }).map((each) => each.textContent)).toEqual([
    "Aisle",
    "3 nights",
  ]);
  expect(settled.queryByRole("button", { name: "Send" })).toBeNull();
  expect(settled.queryByRole("spinbutton")).toBeNull();
});

test("Next and Send say what a question still needs, and Spade's refusal turns the card to the question it names", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", seatAndNights),
  );
  const asked = await card("Travel asks 2 questions");
  await userEvent.click(asked.getByRole("button", { name: "Next" }));
  expect((await asked.findByRole("alert")).textContent).toBe("Pick one.");
  await userEvent.click(asked.getByRole("radio", { name: "Window" }));
  await userEvent.click(asked.getByRole("button", { name: "Next" }));
  await userEvent.type(asked.getByRole("spinbutton", { name: "How many nights?" }), "20");
  await userEvent.click(asked.getByRole("button", { name: "Send" }));
  expect((await asked.findByRole("alert")).textContent).toBe("At most 14.");
  expect(spade.sent("POST", path)).toEqual([]);

  const nights = asked.getByRole("spinbutton", { name: "How many nights?" });
  await userEvent.clear(nights);
  await userEvent.type(nights, "4");
  spade.refuseQuestion = { status: 400, error: "Question 1: Window is sold out." };
  await userEvent.click(asked.getByRole("button", { name: "Send" }));
  expect((await asked.findByRole("alert")).textContent).toBe("Question 1: Window is sold out.");
  // Refused, the card stays open on the question Spade named, with what the person put in.
  expect(asked.getByLabelText("Question 1 of 2")).toBeTruthy();
  expect(asked.getByRole("radio", { name: "Window" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(asked.getByRole("button", { name: "Next question" }));
  expect(
    (asked.getByRole("spinbutton", { name: "How many nights?" }) as HTMLInputElement).value,
  ).toBe("4");
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
  // The "Yes" button also reads Yes, so wait for the person's answer bubble itself.
  await waitFor(async () =>
    expect(
      (await card("Travel asks: Book the 9:40?")).getByRole("article", { name: "You" }).textContent,
    ).toBe("Yes"),
  );
  const settled = await card("Travel asks: Book the 9:40?");
  expect(settled.queryByRole("button", { name: "Yes" })).toBeNull();
});

test("Answer later folds the card to one line, the header counts its questions, and reaching it opens it again until folded back", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.card(travel(api), "q1", seatAndNights),
  );
  const asked = await card("Travel asks 2 questions");
  await userEvent.click(asked.getByRole("button", { name: "Answer later" }));
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ defer: true }]));
  const folded = await cardWith("Travel asks 2 questions", "For later · 2 questions");
  expect(folded.queryByRole("radio")).toBeNull();

  // One card of two questions: two questions for later.
  const later = await screen.findByRole("button", { name: "2 questions for later" });
  await userEvent.click(later);
  await waitFor(() => expect(document.activeElement?.getAttribute("data-question")).toBe("q1"));
  // Answer later folds it back to its line, asking Spade nothing more; Answer opens it again.
  await userEvent.click(
    (await card("Travel asks 2 questions")).getByRole("button", { name: "Answer later" }),
  );
  const refolded = await cardWith("Travel asks 2 questions", "For later · 2 questions");
  expect(spade.sent("POST", path)).toEqual([{ defer: true }]);
  await userEvent.click(refolded.getByRole("button", { name: "Answer" }));
  const reopened = await card("Travel asks 2 questions");
  await userEvent.click(reopened.getByRole("radio", { name: "Window" }));
  await userEvent.click(reopened.getByRole("button", { name: "Next" }));
  await userEvent.type(reopened.getByRole("spinbutton", { name: "How many nights?" }), "2");
  await userEvent.click(reopened.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(spade.sent("POST", path)).toEqual([{ defer: true }, { answers: ["Window", 2] }]),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /questions? for later/ })).toBeNull(),
  );
});

test("a card the bot asked without waiting shows on its list row, folded, and Never mind dismisses it", async () => {
  const { spade } = await spadeApp("/spade", (api) =>
    api.card(travel(api), "q1", [{ prompt: "Which airport?", kind: "text" }], true),
  );
  await waitFor(async () =>
    expect((await botRow("Travel")).textContent).toMatch(/1 question for later$/),
  );
  await userEvent.click(await botRow("Travel"));
  const folded = await card("Travel asks: Which airport?");
  expect(folded.getByText("For later · Which airport?")).toBeTruthy();
  await userEvent.click(folded.getByRole("button", { name: "Answer" }));
  const asked = await card("Travel asks: Which airport?");
  expect(asked.getByRole("textbox", { name: "Which airport?" })).toBeTruthy();
  await userEvent.click(asked.getByRole("button", { name: "Never mind" }));
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ dismiss: true }]));
  expect(await cardWith("Travel asks: Which airport?", "Dismissed")).toBeTruthy();
});

test("an older question with no kinds is one text card", async () => {
  const { spade } = await spadeApp("/spade/travel", (api) =>
    api.question(travel(api), "q1", "Which airport?"),
  );
  const asked = await card("Travel asks: Which airport?");
  await userEvent.type(asked.getByRole("textbox", { name: "Which airport?" }), "Heathrow{Enter}");
  await waitFor(() => expect(spade.sent("POST", path)).toEqual([{ answers: ["Heathrow"] }]));
});
