import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openNew, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withSpade = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
};

const studio = { hostId: "studio", name: "Studio Mac", seed: withEndpoint };

/** + › New bot, then the bot renamed where its name shows. */
async function newBot(name: string) {
  await openNew("New bot");
  const field = await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" });
  await userEvent.clear(field);
  await userEvent.type(field, name);
  return field;
}

async function send(name: string, text: string) {
  await userEvent.type(screen.getByRole("combobox", { name: `Message ${name}` }), `${text}{Enter}`);
}

test("New bot is a conversation: a name that suits its face, and the first message makes the bot with it", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withSpade(api);
    api.newBotModel = "openrouter/anthropic/sonnet";
  });
  await openNew("New bot");
  // No form: the bot as it will be, its name already one that suits its face.
  expect(screen.queryByRole("dialog")).toBeNull();
  const name = await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" });
  expect(name.value).not.toBe("");
  // It starts on the model for new bots, and says so on its line.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" }).textContent).toMatch(/sonnet/i),
  );

  await userEvent.clear(name);
  await userEvent.type(name, "Trips");
  await send("Trips", "Plan a weekend in Oslo");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      {
        name: "Trips",
        task: "Plan a weekend in Oslo",
        avatar: expect.objectContaining({ kind: "character", v: 1 }),
        first_message: { text: "Plan a weekend in Oslo" },
      },
    ]),
  );
  // One call made both: the message isn't sent again on its own.
  const made = spade.agents.find((agent) => agent.name === "Trips");
  expect(spade.sent("POST", `/v1/conversations/${made?.conversation}/messages`)).toEqual([]);
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Trips" }));
  await chat.findByText("Plan a weekend in Oslo");
  expect((await botRow("Trips")).getAttribute("aria-current")).toBe("page");
});

test("the bot runs on the machine and model chosen on its line", async () => {
  const { spade, others } = await spadeApp("/spade", withSpade, { machines: [studio] });
  await newBot("Travel");
  await userEvent.click(await screen.findByRole("button", { name: "Machine: This machine" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Studio Mac" }));
  await screen.findByRole("button", { name: "Machine: Studio Mac" });
  // Another machine keeps the name the person gave.
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Travel");
  await userEvent.click(screen.getByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Sonnet/ }));
  await send("Travel", "Book Lisbon");
  await waitFor(() =>
    expect(others.get("studio")?.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({
        name: "Travel",
        model: "openrouter/anthropic/sonnet",
        first_message: { text: "Book Lisbon" },
      }),
    ]),
  );
  expect(spade.sent("POST", "/v1/agents")).toEqual([]);
  await screen.findByRole("feed", { name: "Conversation with Travel" });
});

test("a template names the bot after it, unless a bot has that name, and brings its own task", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    withSpade(api);
    api.addAgent({ id: "digest", name: "Morning digest" });
    api.teams.templates.push({
      id: "digest",
      name: "Morning digest",
      blurb: "Your feeds, summed up.",
      task: "Summarise my feeds.",
      face: { kind: "character", v: 1, body: "bird", pair: "sky", marking: "cap" },
      model_kind: "fast",
      routines: [],
    });
  });
  await openNew("New bot");
  await userEvent.click(await screen.findByRole("button", { name: /^Morning digest/ }));
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe(
    "Morning digest 2",
  );
  await send("Morning digest 2", "Start with the tech feeds");
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({
        name: "Morning digest 2",
        // Empty: Spade gives it the template's task.
        task: "",
        template: "digest",
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        avatar: expect.objectContaining({ body: "bird", pair: "sky", marking: "cap" }),
        first_message: { text: "Start with the tech feeds" },
      }),
    ]),
  );
});

test("the face changes from its popover, one part at a time, or to an uploaded picture", async () => {
  const { spade } = await spadeApp("/spade", withSpade);
  await newBot("Wren");
  await userEvent.click(await screen.findByRole("button", { name: "Change face" }));
  const face = within(await screen.findByRole("dialog", { name: "Face" }));
  await userEvent.click(face.getByRole("radio", { name: "Creature: bird" }));
  // The finer parts are one fold away; a bird has no ears to offer.
  expect(face.queryByRole("radiogroup", { name: "Eyes" })).toBeNull();
  await userEvent.click(face.getByRole("button", { name: /^Ears, marking/ }));
  expect(face.getByRole("radiogroup", { name: "Eyes" })).toBeTruthy();
  expect(face.queryByRole("radiogroup", { name: "Ears" })).toBeNull();
  await userEvent.click(face.getByRole("radio", { name: "Colours: cocoa" }));
  await userEvent.keyboard("{Escape}");
  await send("Wren", "Watch the feeder");
  await waitFor(() => expect(spade.sent("POST", "/v1/agents")).toHaveLength(1));
  expect(spade.sent("POST", "/v1/agents")[0]).toMatchObject({
    avatar: { kind: "character", body: "bird", pair: "cocoa" },
  });

  await newBot("Me");
  await userEvent.click(await screen.findByRole("button", { name: "Change face" }));
  const picture = within(await screen.findByRole("dialog", { name: "Face" }));
  const png = new File([new Uint8Array([137, 80, 78, 71])], "me.png", { type: "image/png" });
  await userEvent.upload(picture.getByLabelText("Picture"), png);
  await picture.findByRole("button", { name: "Use a face" });
  await userEvent.keyboard("{Escape}");
  await send("Me", "Hello");
  await waitFor(() => expect(spade.sent("POST", "/v1/agents")).toHaveLength(2));
  expect(spade.sent("POST", "/v1/agents")[1]).toMatchObject({
    name: "Me",
    avatar: { kind: "image", data: expect.stringMatching(/^data:image\/png;base64,/) },
  });
});

test("on an older Spade without character faces, a new bot gets initials in the nearest colour", async () => {
  const { others } = await spadeApp("/spade", withSpade, {
    machines: [
      {
        hostId: "old",
        name: "Old Mac",
        seed: (api) => {
          withEndpoint(api);
          api.characterAvatars = false;
        },
      },
    ],
  });
  await newBot("River Scout");
  await userEvent.click(await screen.findByRole("button", { name: "Machine: This machine" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Old Mac" }));
  await userEvent.click(await screen.findByRole("button", { name: "Change face" }));
  const face = within(await screen.findByRole("dialog", { name: "Face" }));
  await userEvent.click(face.getByRole("radio", { name: "Colours: lagoon" }));
  await userEvent.keyboard("{Escape}");
  await send("River Scout", "Scout the river");
  await waitFor(() =>
    expect(others.get("old")?.sent("POST", "/v1/agents")).toEqual([
      expect.objectContaining({ avatar: { kind: "generated", initials: "RS", color: "teal" } }),
    ]),
  );
  await screen.findByRole("feed", { name: "Conversation with River Scout" });
});

test("a machine chosen for a new bot that goes out of reach stays chosen, and says so", async () => {
  const { app } = await spadeApp("/spade", withSpade, { machines: [studio] });
  await newBot("Travel");
  await userEvent.click(await screen.findByRole("button", { name: "Machine: This machine" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Studio Mac" }));
  await screen.findByRole("button", { name: "Machine: Studio Mac" });
  app.crashMachine("studio");
  expect(await screen.findByText("Studio Mac isn't reachable right now.")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: /^Message/ })).toBeNull();
});
