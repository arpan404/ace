import type { FakeSpadeApi } from "@ace/fake-daemon";
import { isValidFace, repairFace } from "@ace/ui-core/bot-face";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const face = (fields: Record<string, string>) => ({ kind: "character", v: 1, ...fields });
const faceOf = (scope: Element) => scope.querySelector("svg.bot-face");

function crew(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  const scout = spade.addAgent({
    id: "scout",
    name: "Scout",
    avatar: face({ body: "round", pair: "lagoon", mouth: "smile", accessory: "glasses" }),
  });
  spade.store(scout.conversation, { type: "user_message", text: "Read the Q3 report." });
  spade.store(scout.conversation, { type: "reply_started", reply: "r-scout" });
  spade.status(scout, "working", "Reading the quarterly report");
  const ferry = spade.addAgent({ id: "ferry", name: "Ferry", avatar: face({ body: "ghost" }) });
  spade.ask(ferry, "k-mail", "send_email");
  spade.addAgent({
    id: "pixel",
    name: "Pixel",
    avatar: face({ body: "bot", pair: "stone" }),
    problem: "Codex is signed out.",
  });
  spade.addAgent({ id: "fern", name: "Fern", avatar: face({ body: "sprout", pair: "mint" }) });
}

/** Fern's profile, then its face: the popover with the face's full editor. */
async function editor() {
  await screen.findByRole("feed", { name: "Conversation with Fern" });
  await openProfile("Fern");
  await userEvent.click(await screen.findByRole("button", { name: "Change face" }));
  const dialog = await screen.findByRole("dialog");
  return { dialog, form: within(dialog) };
}

/** The editor's big face: the one whose parts step on click. */
const bigFace = (dialog: HTMLElement) => dialog.querySelector("svg.bot-face[data-editable]");
const checkedIn = (form: ReturnType<typeof within>, group: string) =>
  within(form.getByRole("radiogroup", { name: group }))
    .getAllByRole("radio")
    .find((radio) => radio.getAttribute("aria-checked") === "true")
    ?.getAttribute("aria-label");

test("each roster row's face is its bot's state: working, needs you, blocked or resting", async () => {
  await spadeApp("/spade", crew);
  const states = async () =>
    Object.fromEntries(
      await Promise.all(
        ["Scout", "Ferry", "Pixel", "Fern"].map(async (name) => [
          name,
          faceOf(await botRow(name))?.getAttribute("data-state"),
        ]),
      ),
    );
  await waitFor(async () =>
    expect(await states()).toEqual({
      Scout: "working",
      Ferry: "needs-you",
      Pixel: "blocked",
      Fern: "idle",
    }),
  );
  expect(faceOf(await botRow("Scout"))?.getAttribute("data-face")).toBe("round lagoon");
});

test("while a bot works, the working line carries its face working; asking, the line goes and no face sits by the request", async () => {
  const { spade } = await spadeApp("/spade/scout", crew);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  const line = await chat.findByRole("status");
  expect(line.textContent).toContain("Reading the quarterly report");
  expect(faceOf(line)?.getAttribute("data-state")).toBe("working");
  const scout = spade.agents.find((agent) => agent.id === "scout");
  if (!scout) throw new Error("no Scout");
  spade.ask(scout, "k-sheet", "write_sheet", undefined, "r-scout");
  const request = await chat.findByRole("group", { name: /^Scout wants to/ });
  // A one-to-one chat keeps no face beside its bubbles: the pill and the list carry its pose.
  expect(request.closest<HTMLElement>("[role=article]")?.querySelector("svg.bot-face")).toBeNull();
  // The wait is said once, in the request: the working line goes.
  await waitFor(() => expect(chat.queryByRole("status")).toBeNull());
});

test("the editor changes one part at a time, hides what doesn't fit, and steps a part on click", async () => {
  const { spade } = await spadeApp("/spade/fern", crew);
  const { dialog, form } = await editor();
  await userEvent.click(form.getByRole("radio", { name: "Creature: round" }));
  // The creature and colours show first; More shows the other parts.
  expect(form.queryByRole("radiogroup", { name: "Extra" })).toBeNull();
  await userEvent.click(form.getByRole("button", { name: "More" }));
  await userEvent.click(form.getByRole("radio", { name: "Extra: none" }));
  await userEvent.click(form.getByRole("radio", { name: "Ears: bunny" }));
  // Bunny ears and headphones share a place: headphones are not offered.
  const extras = within(form.getByRole("radiogroup", { name: "Extra" }));
  expect(extras.queryByRole("radio", { name: "Extra: headphones" })).toBeNull();
  // A bird has no ears and no mouth: those parts aren't offered at all.
  await userEvent.click(form.getByRole("radio", { name: "Creature: bird" }));
  expect(form.queryByRole("radiogroup", { name: "Ears" })).toBeNull();
  expect(form.queryByRole("radiogroup", { name: "Mouth" })).toBeNull();
  expect(bigFace(dialog)?.getAttribute("data-face")).toMatch(/^bird /);
  // Clicking the big face's eyes steps the eyes to the next shape.
  const before = checkedIn(form, "Eyes");
  const eyes = bigFace(dialog)?.querySelector('[data-part="eyes"]');
  if (!eyes) throw new Error("no eyes on the big face");
  await userEvent.click(eyes);
  expect(checkedIn(form, "Eyes")).not.toBe(before);
  // Closing the popover saves the face.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(spade.sent("PATCH", "/v1/agents/fern")).toHaveLength(1));
  const [sent] = spade.sent("PATCH", "/v1/agents/fern") as { avatar: Record<string, unknown> }[];
  expect(sent?.avatar).toMatchObject({ kind: "character", v: 1, body: "bird", ears: "none" });
});

test("Shuffle makes a new valid face each time", async () => {
  await spadeApp("/spade/fern", crew);
  const { dialog, form } = await editor();
  // Every part, so each shuffled one can be read back.
  await userEvent.click(form.getByRole("button", { name: "More" }));
  for (let round = 0; round < 4; round++) {
    const before = bigFace(dialog)?.getAttribute("data-face");
    await userEvent.click(form.getByRole("button", { name: "Shuffle" }));
    const after = bigFace(dialog)?.getAttribute("data-face") ?? "";
    expect(after.split(" ")[0]).not.toBe(before?.split(" ")[0]);
    const fields = Object.fromEntries(
      ["Creature", "Colours", "Ears", "Marking", "Eyes", "Mouth", "Cheeks", "Extra"].map(
        (group) => {
          const key = { Creature: "body", Colours: "pair", Extra: "accessory" }[group];
          const label = form.queryByRole("radiogroup", { name: group })
            ? checkedIn(form, group)
            : undefined;
          return [key ?? group.toLowerCase(), label?.split(": ")[1] ?? "none"];
        },
      ),
    );
    const read = repairFace(fields);
    expect(isValidFace(read)).toBe(true);
    expect(read).toMatchObject(fields);
  }
});

/** Opens the popover of Fern's face in its profile. */
async function faceOfFern() {
  await userEvent.click(await screen.findByRole("button", { name: "Change face" }));
  return within(await screen.findByRole("dialog"));
}

test("changing a bot's face in its profile sends the new face as it closes; leaving it sends none", async () => {
  const { spade } = await spadeApp("/spade/fern", crew);
  await screen.findByRole("feed", { name: "Conversation with Fern" });
  await openProfile("Fern");
  let popover = await faceOfFern();
  expect(checkedIn(popover, "Creature")).toBe("Creature: sprout");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(spade.sent("PATCH", "/v1/agents/fern")).toEqual([]);

  popover = await faceOfFern();
  await userEvent.click(popover.getByRole("button", { name: "More" }));
  await userEvent.click(popover.getByRole("radio", { name: "Mouth: grin" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(spade.sent("PATCH", "/v1/agents/fern")).toHaveLength(1));
  expect(spade.sent("PATCH", "/v1/agents/fern")[0]).toMatchObject({
    avatar: { kind: "character", body: "sprout", pair: "mint", mouth: "grin" },
  });
});
