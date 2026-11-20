import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("the about-you interview writes the notes, then starter bots are one click each", async () => {
  const { spade } = await spadeApp("/spade/main", (api) => {
    withEndpoint(api);
    api.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
      model: "openrouter/anthropic/sonnet",
    });
    api.onboarding.about_you = null;
    api.onboarding.starters = null;
    api.teams.templates.push({
      id: "inbox",
      name: "Inbox",
      blurb: "Sorts what came in.",
      task: "Sort my inbox.",
      face: { kind: "character", v: 1, body: "bird", pair: "sky", marking: "cap" },
      model_kind: "fast",
      routines: [],
    });
  });
  const card = within(await screen.findByLabelText("About you"));
  await userEvent.type(
    card.getByRole("textbox", { name: "What should I call you?" }),
    "Sam{Enter}",
  );
  await userEvent.type(
    await card.findByRole("textbox", { name: "What do you do?" }),
    "Nurse{Enter}",
  );
  // A question left empty is skipped.
  await card.findByRole("textbox", { name: "What would you like help with?" });
  await userEvent.click(card.getByRole("button", { name: "Skip this one" }));
  await userEvent.click(await card.findByRole("button", { name: "Short and to the point" }));
  await userEvent.click(card.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(
      spade.notes.notes.filter((note) => note.agent === null).map((note) => note.text),
    ).toEqual([
      "The person's name is Sam.",
      "What they do: Nurse",
      "How they like to be talked to: Short and to the point",
    ]),
  );
  expect(spade.onboarding.about_you).toBe("done");

  const starters = within(await screen.findByLabelText("Starter bots"));
  await userEvent.click(starters.getByRole("button", { name: "Create Inbox" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({ template: "inbox" }),
    ]),
  );
  await starters.findByText("Created");
  await userEvent.click(starters.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(spade.onboarding.starters).toBe("done"));
  await waitFor(() => expect(screen.queryByLabelText("Starter bots")).toBeNull());
});

test("skipping the interview writes nothing and doesn't ask again", async () => {
  const { spade } = await spadeApp("/spade/main", (api) => {
    withEndpoint(api);
    api.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
      model: "openrouter/anthropic/sonnet",
    });
    api.onboarding.about_you = null;
  });
  const card = within(await screen.findByLabelText("About you"));
  await userEvent.click(card.getByRole("button", { name: "Skip for now" }));
  await waitFor(() => expect(spade.onboarding.about_you).toBe("skipped"));
  await waitFor(() => expect(screen.queryByLabelText("About you")).toBeNull());
  expect(spade.notes.notes).toEqual([]);
});
