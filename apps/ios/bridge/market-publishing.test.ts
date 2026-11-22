import "./test-host.ts";
import { marketPickFixture, marketPublishFixture } from "@ace/fake-daemon";
import { afterEach, expect, test } from "vitest";
import { NativePublish, NativePublishRequest } from "./market-publishing.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";
import type { PairedStanding } from "./socket.ts";

/*
 * Publishing a bot, skill or plugin from the phone and managing its listings (#2548, #2554),
 * through the fake daemon's market: what the picker offers, what a draft would upload, ace's
 * checks, the submit and its refusals, a withdrawal and a profile edit.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

type Answer = Record<string, unknown> & {
  ok: boolean;
  code?: string;
  message?: string;
  way?: string | null;
};

async function market(standing: PairedStanding | undefined = "proven") {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    marketplace: {
      categories: [{ id: "mail", title: "Mail" }],
      publishing: marketPublishFixture(),
      pick: marketPickFixture(),
    },
  });
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const facts = { standing };
  const service = new NativePublish(
    client,
    async () => {},
    () => facts.standing,
  );
  const ask = async (step: Record<string, unknown>, confirmed = false) =>
    (await service.answer(
      NativePublishRequest.parse({
        type: "market.publish",
        step,
        ...(confirmed ? { confirmed: true } : {}),
      }),
      new AbortController().signal,
    )) as Answer;
  return { ask, daemon, client, facts };
}

type Item = { id: string; name: string; state: string; version: string; fromText: string };
type Check = {
  hash: string;
  filesText: string;
  blocking: number;
  bot: Record<string, unknown> | null;
};
type Draft = { id: string; scanning: boolean; failing: number; verdictText: string };

/** Picks `name` of `type`, checks it and makes its draft, as the phone's steps do. */
async function drafted(ask: Awaited<ReturnType<typeof market>>["ask"], type: string, name: string) {
  const items = (await ask({ step: "pick", type })).items as Item[];
  const item = items.find((each) => each.name === name);
  if (!item) throw new Error(`${name} isn't offered`);
  const check = (await ask({ step: "check", type, name, pick: item.id })) as Answer & Check;
  const made = await ask({
    step: "draft",
    type,
    name,
    pick: item.id,
    version: item.version,
    hash: check.hash,
  });
  return { item, check, draft: made.draft as Draft };
}

const listing = {
  title: "Release notes",
  line: "Writes release notes from merged work.",
  description: "Reads what merged and writes the notes.",
  categories: ["mail"],
};

test("the picker offers the person's own skills with where each stands in the market", async () => {
  const { ask } = await market();
  const answer = await ask({ step: "pick", type: "spade-skill" });
  expect(answer.ok).toBe(true);
  expect(answer.items).toEqual([
    expect.objectContaining({
      name: "release-notes",
      fromText: "In Spade",
      state: "Never published",
      version: "1.0.0",
    }),
    // A draft of it is already up, so the phone carries on with that draft.
    expect.objectContaining({ name: "triage-mail", fromText: "In ace's skills", state: "Draft" }),
  ]);
});

test("a skill published from the phone shows under the person's listings, waiting for review", async () => {
  const { ask, daemon } = await market();
  const { check, draft } = await drafted(ask, "spade-skill", "release-notes");
  expect(check).toMatchObject({
    ok: true,
    filesText: "1 file · 120 bytes",
    blocking: 0,
    bot: null,
  });
  // The scan finished while the bridge read the draft again; the phone never polls.
  expect(draft).toMatchObject({ scanning: false, failing: 0, verdictText: "Passes ace's checks." });

  const submitted = await ask({
    step: "submit",
    draft: draft.id,
    version: "1.0.0",
    notes: "First version.",
    listing,
  });
  expect(submitted).toMatchObject({
    ok: true,
    published: {
      name: "release-notes",
      version: "1.0.0",
      held: false,
      title: "Release notes is waiting for review",
      listingProblem: null,
    },
  });
  const me = await ask({ step: "me" });
  expect(me.listings).toContainEqual(
    expect.objectContaining({
      name: "release-notes",
      title: "Release notes",
      statusText: "1.0.0 · Waiting for review",
    }),
  );
  // What the daemon uploads is what the person confirmed, by the hash they were shown.
  expect(daemon.marketplace.publishing.sources.at(-1)).toMatchObject({
    name: "release-notes",
    checked: { hash: check.hash },
  });
});

test("a bot's review lists what it shares, the apps it asks for and what it leaves out", async () => {
  const { ask } = await market();
  const items = (await ask({ step: "pick", type: "spade-bot" })).items as Item[];
  const bot = items[0];
  // A bot's profile finds its own row by the bot's id.
  expect(bot).toMatchObject({ name: "inbox-sorter", bot: "a_inbox" });
  const check = await ask({
    step: "check",
    type: "spade-bot",
    name: "inbox-sorter",
    pick: bot?.id,
  });
  expect(check.bot).toMatchObject({
    task: "You look after Arlo Quint's inbox.",
    routines: [
      { index: 0, name: "Morning sort", schedule: "weekdays at 8:00" },
      { index: 1, name: "File receipts" },
    ],
    skills: ["triage-mail"],
    plugins: ["mail-tools"],
    apps: [{ label: "gmail", required: true }],
    effects: [],
  });
  expect((check.bot as { leftOut: string[] }).leftOut).toHaveLength(2);
});

test("a bot published with one routine left out sends only the routines kept", async () => {
  const { ask, daemon } = await market();
  const items = (await ask({ step: "pick", type: "spade-bot" })).items as Item[];
  const pick = items[0]?.id;
  const check = (await ask({
    step: "check",
    type: "spade-bot",
    name: "inbox-sorter",
    pick,
  })) as Answer & Check;
  await ask({
    step: "draft",
    type: "spade-bot",
    name: "inbox-sorter",
    pick,
    version: "1.0.0",
    hash: check.hash,
    routines: [0],
  });
  const sent = daemon.marketplace.publishing.sources.at(-1)?.checked;
  expect(sent?.recipe?.routines.map((routine) => routine.name)).toEqual(["Morning sort"]);
  // The names it flagged are confirmed as seen; nothing the person wasn't shown.
  expect(sent?.accepted).toContain("Arlo Quint");
});

test("a draft from a check the bridge no longer holds asks to look at it again", async () => {
  const { ask } = await market();
  const items = (await ask({ step: "pick", type: "spade-skill" })).items as Item[];
  const answer = await ask({
    step: "draft",
    type: "spade-skill",
    name: "release-notes",
    pick: items[0]?.id,
    version: "1.0.0",
    hash: "0".repeat(64),
  });
  expect(answer).toMatchObject({
    ok: false,
    code: "expired",
    message: "Look at what it uploads again, then confirm it.",
    way: "reread",
  });
});

test("a picked id that names a folder on the machine is refused before anything is sent", async () => {
  const { ask } = await market();
  const answer = await ask({
    step: "check",
    type: "spade-skill",
    name: "release-notes",
    pick: JSON.stringify({ kind: "folder", path: "/etc" }),
  });
  expect(answer).toMatchObject({ ok: false, code: "invalid" });
});

test("a submit the scan refuses shows its sentence and what the scan found", async () => {
  const { ask } = await market();
  const answer = await ask({
    step: "submit",
    draft: "drf_blockednext",
    version: "1.0.1",
    listing: { ...listing, title: "Setup mail" },
  });
  expect(answer).toMatchObject({
    ok: false,
    code: "blocked",
    message: "ace's scan refused it. Fix what it found, then try again.",
  });
  expect(answer.reason).toMatch(/downloads a script and runs it/);
});

test("a submit refused for standing offers Confirm it's you, and the retry publishes", async () => {
  const { ask, daemon } = await market("proven");
  const { draft } = await drafted(ask, "spade-skill", "release-notes");
  daemon.marketplace.refusePublish = { op: "error", code: "reauth", message: "Confirm it's you" };
  const submit = { step: "submit", draft: draft.id, version: "1.0.0", listing };
  expect(await ask(submit)).toMatchObject({ ok: false, code: "reauth", way: "confirm" });
  daemon.marketplace.refusePublish = undefined;
  expect(await ask(submit, true)).toMatchObject({ ok: true, published: { name: "release-notes" } });
});

test("a phone that can't prove the person's standing is sent to pair again to publish", async () => {
  const { ask, daemon } = await market("missing");
  const { draft } = await drafted(ask, "spade-skill", "release-notes");
  daemon.marketplace.refusePublish = { op: "error", code: "reauth", message: "Confirm it's you" };
  expect(await ask({ step: "submit", draft: draft.id, version: "1.0.0", listing })).toMatchObject({
    ok: false,
    message: "Pair this iPhone again to publish from it.",
    way: "pairAgain",
  });
});

test("signed out, the publisher's page says to sign in to publish", async () => {
  const { ask, daemon } = await market();
  daemon.seedServices({ marketplace: { publishing: { signedOut: true } } });
  expect(await ask({ step: "me" })).toMatchObject({
    ok: false,
    code: "signed_out",
    message: "Sign in to publish.",
  });
});

test("with the machine away, a submit says nothing was changed", async () => {
  const { ask, client } = await market();
  await client.close();
  expect(await ask({ step: "submit", draft: "drf_heldnext", version: "2.0.1", listing })).toEqual({
    ok: false,
    offline: true,
    code: "offline",
    message: "Your machine is offline. Nothing was changed.",
    way: "retry",
  });
});

test("a listing shows its versions and signals, and a withdrawn version reads as withdrawn", async () => {
  const { ask } = await market();
  const before = (await ask({ step: "listing", type: "suit", name: "harbour-dusk" })).listing;
  expect(before).toMatchObject({
    title: "Harbour dusk",
    versions: [
      { version: "1.2.0", statusText: "Live", withdrawable: true },
      { version: "1.1.0", statusText: "Live" },
    ],
    signals: {
      downloadsText: "56 installs in the last 30 days",
      adoptionText: "80% on 1.2.0",
      reports: [{ reasonText: "Spam", stateText: "Dismissed" }],
    },
  });
  const withdrawn = await ask({
    step: "withdraw",
    type: "suit",
    name: "harbour-dusk",
    version: "1.1.0",
    reason: "It has a contrast bug.",
  });
  expect(withdrawn).toMatchObject({
    ok: true,
    message: "1.1.0 is withdrawn. Anyone who installed it sees that it was withdrawn.",
    listing: {
      versions: [
        { version: "1.2.0", statusText: "Live" },
        {
          version: "1.1.0",
          statusText: "Withdrawn",
          reason: "It has a contrast bug.",
          withdrawable: false,
        },
      ],
    },
  });
});

test("a profile edit from the phone is what the publisher's page reads next", async () => {
  const { ask } = await market();
  const edited = await ask({
    step: "profile",
    name: "Harbour",
    bio: "Calm Suits.",
    links: [{ label: "Site", url: "https://harbour.example/new" }],
  });
  expect(edited).toMatchObject({
    ok: true,
    profile: { handle: "harbour", name: "Harbour", bio: "Calm Suits." },
  });
  expect((await ask({ step: "me" })).profile).toMatchObject({
    name: "Harbour",
    links: [{ label: "Site", url: "https://harbour.example/new" }],
  });
});
