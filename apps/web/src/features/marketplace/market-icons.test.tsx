import { marketPublishFixture } from "@ace/fake-daemon";
import { configure, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { spadeApp } from "@/test/spade.ts";
import { entry, findMarket, openApp, seed } from "./market-test-seed.ts";

configure({ asyncUtilTimeout: 10000 });
afterEach(() => localStorage.clear());

/*
 * The Marketplace draws what each thing really looks like: an app its catalogue mark (its letter
 * only when it has none), a bot its own face, and ace's own publisher the ace logo.
 */

test("the Apps list draws a catalogue app's real mark, and a letter only for an app with no art", async () => {
  await spadeApp(
    "/chats?market=apps",
    (api) => {
      api.connectors.catalogue.push(
        {
          id: "github",
          name: "GitHub",
          url: "https://api.githubcopilot.com/mcp/",
          sign_in: ["token"],
          notes: "",
        },
        {
          id: "zz-no-art",
          name: "Zebra desk",
          url: "https://zebra.example/mcp",
          sign_in: ["token"],
          notes: "",
        },
      );
    },
    { daemon: (daemon) => daemon.seedServices({ marketplace: seed }) },
  );
  const market = await findMarket();
  const github = (await within(market).findByText("GitHub")).closest("li") as HTMLElement;
  const zebra = (await within(market).findByText("Zebra desk")).closest("li") as HTMLElement;

  await waitFor(() => expect(github.querySelector('[data-app="github"] svg')).not.toBeNull());
  expect(github.textContent).not.toContain("G ");
  await waitFor(() => expect(zebra.querySelector('[data-part="avatar"]')?.textContent).toBe("Z"));
  expect(zebra.querySelector("svg")).toBeNull();
});

const bot = (face: Record<string, unknown> | undefined) => ({
  summary: entry("spade-bot", "inbox", "Inbox"),
  review: {
    body: {
      type: "spade-bot" as const,
      botName: "Inbox",
      ...(face ? { face } : {}),
      task: "You look after the inbox.",
      model: "fast" as const,
      routines: [],
      notes: [],
      brings: [],
      needs: [],
      spadeReady: true,
    },
  },
});

const ownBot = () => {
  const fixture = marketPublishFixture();
  const me = fixture.me;
  const template = fixture.entries?.[0];
  if (!me || !template) throw new Error("the fixture has a publisher with an entry");
  const mine = {
    ...template,
    summary: { ...template.summary, type: "spade-bot" as const, name: "inbox", title: "Inbox" },
  };
  return { ...fixture, entries: [mine], me: { ...me, entries: [mine.summary] } };
};

test("a bot on Your profile's Published list draws its own face", async () => {
  await openApp("/chats?market=me", {
    entries: [bot({ kind: "character", v: 1, body: "bird", pair: "sky", marking: "cap" })],
    publishing: ownBot(),
  });
  const market = await findMarket();
  const row = (
    await within(market).findByText("Inbox", { selector: ".mk-mine-row .mk-name" })
  ).closest(".mk-mine-row") as HTMLElement;

  await waitFor(() => expect(row.querySelector('.mk-stage[data-type="bot"] svg')).not.toBeNull());
});

test("a bot whose recipe has no face keeps the generic bot mark", async () => {
  await openApp("/chats?market=me", { entries: [bot(undefined)], publishing: ownBot() });
  const market = await findMarket();
  const row = (
    await within(market).findByText("Inbox", { selector: ".mk-mine-row .mk-name" })
  ).closest(".mk-mine-row") as HTMLElement;

  expect(row.querySelector('.mk-stage[data-type="mark"]')).not.toBeNull();
  expect(row.querySelector('.mk-stage[data-type="bot"]')).toBeNull();
});

const logoIn = (root: HTMLElement) =>
  root.querySelector('[data-part="avatar"][data-variant="ace"] svg');

/** The fixture's own profile, named "ace", with the daemon's official mark or without it. */
function profileNamedAce(official: boolean) {
  const fixture = marketPublishFixture();
  const me = fixture.me;
  if (!me?.profile) throw new Error("the fixture has a signed-in publisher with a profile");
  const profile = { ...me.profile, displayName: "ace", ...(official ? { official } : {}) };
  return { ...fixture, me: { ...me, profile } };
}

test("Your profile draws the ace logo for the official publisher", async () => {
  await openApp("/chats?market=me", { publishing: profileNamedAce(true) });
  const market = await findMarket();
  await within(market).findByRole("heading", { level: 1, name: /^ace/ });
  expect(logoIn(market.querySelector(".mk-profile-head") as HTMLElement)).not.toBeNull();
});

test("Your profile does not draw the logo for a publisher who only named itself ace", async () => {
  await openApp("/chats?market=me", { publishing: profileNamedAce(false) });
  const market = await findMarket();
  await within(market).findByRole("heading", { level: 1, name: /^ace/ });
  const head = market.querySelector(".mk-profile-head") as HTMLElement;
  expect(logoIn(head)).toBeNull();
  expect(head.querySelector('[data-part="avatar"]')?.textContent).toBe("A");
});
