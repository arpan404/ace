import type { FakeSpadeApi } from "@ace/fake-daemon";
import { isValidFace, repairFace } from "@ace/ui-core/bot-face";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

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

async function newBot() {
  await userEvent.click(await screen.findByRole("button", { name: "New bot" }));
  return within(await screen.findByRole("dialog", { name: "New bot" }));
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

test("while a bot works, the working line carries its face working; asking, it asks", async () => {
  const { spade } = await spadeApp("/spade/scout", crew);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  const line = await chat.findByRole("status");
  expect(line.textContent).toContain("Reading the quarterly report");
  expect(faceOf(line)?.getAttribute("data-state")).toBe("working");
  const scout = spade.agents.find((agent) => agent.id === "scout");
  if (!scout) throw new Error("no Scout");
  spade.ask(scout, "k-sheet", "write_sheet", undefined, "r-scout");
  await waitFor(() =>
    expect(faceOf(chat.getByRole("status"))?.getAttribute("data-state")).toBe("needs-you"),
  );
});

test("the editor changes one part at a time, hides what doesn't fit, and steps a part on click", async () => {
  const { spade } = await spadeApp("/spade", crew);
  const form = await newBot();
  const dialog = await screen.findByRole("dialog", { name: "New bot" });
  await userEvent.click(form.getByRole("radio", { name: "Creature: round" }));
  // The new face is random: start this one bare.
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
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Wren");
  await userEvent.click(form.getByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await userEvent.click(form.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(spade.sent("POST", "/v1/agents")).toHaveLength(1));
  const [sent] = spade.sent("POST", "/v1/agents") as { avatar: Record<string, unknown> }[];
  expect(sent?.avatar).toMatchObject({ kind: "character", v: 1, body: "bird", ears: "none" });
});

test("Shuffle makes a new valid face each time, and a suggested name fills the name", async () => {
  await spadeApp("/spade", crew);
  const form = await newBot();
  const dialog = await screen.findByRole("dialog", { name: "New bot" });
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
  const names = within(form.getByLabelText("Names that suit this face"));
  const [first] = names.getAllByRole("button");
  if (!first) throw new Error("no names");
  await userEvent.click(first);
  expect(form.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe(
    first.textContent,
  );
});

test("Upload picture still gives a bot a picture instead of a face", async () => {
  const { spade } = await spadeApp("/spade", crew);
  const form = await newBot();
  const png = new File([new Uint8Array([137, 80, 78, 71])], "me.png", { type: "image/png" });
  await userEvent.upload(form.getByLabelText("Picture"), png);
  await form.findByRole("button", { name: "Use a face" });
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Me");
  await userEvent.click(form.getByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await userEvent.click(form.getByRole("button", { name: "Create bot" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({
        name: "Me",
        avatar: { kind: "image", data: expect.stringMatching(/^data:image\/png;base64,/) },
      }),
    ]),
  );
});

/** Opens the open bot's Edit dialog. */
async function editFern() {
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit bot" }));
  return within(await screen.findByRole("dialog", { name: "Edit Fern" }));
}

test("editing a bot's face sends the new face; leaving it sends none", async () => {
  const { spade } = await spadeApp("/spade/fern", crew);
  await screen.findByRole("feed", { name: "Conversation with Fern" });
  let dialog = await editFern();
  expect(checkedIn(dialog, "Creature")).toBe("Creature: sprout");
  await userEvent.type(dialog.getByRole("textbox", { name: "Task" }), "Water the beds.");
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(spade.sent("PATCH", "/v1/agents/fern")).toHaveLength(1));
  expect(spade.sent("PATCH", "/v1/agents/fern")[0]).not.toHaveProperty("avatar");
  dialog = await editFern();
  await userEvent.click(dialog.getByRole("radio", { name: "Mouth: grin" }));
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(spade.sent("PATCH", "/v1/agents/fern")).toHaveLength(2));
  expect(spade.sent("PATCH", "/v1/agents/fern")[1]).toMatchObject({
    avatar: { kind: "character", body: "sprout", pair: "mint", mouth: "grin" },
  });
});
