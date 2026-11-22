import "./test-host.ts";
import type { MarketInstalled } from "@ace/protocol/marketplace";
import { afterEach, expect, test } from "vitest";
import { installedAnswer } from "./market-installed.ts";
import { NativeMarket, NativeMarketRequest } from "./market.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";

/* Installed and updates on the phone (spec items 16 to 19): the rows' words and their actions. */

const install = (name: string, extra: Partial<MarketInstalled> = {}): MarketInstalled => ({
  source: "market",
  type: "spade-skill",
  name,
  title: name,
  version: "1.0.0",
  hash: "c".repeat(64),
  acceptedAt: 1,
  state: "on",
  ...extra,
});
const answer = (...installed: MarketInstalled[]) => installedAnswer({ op: "installed", installed });
const only = (item: MarketInstalled) => answer(item).rows[0];

test("two waiting updates lead the list and are counted for the Marketplace entry", () => {
  const read = answer(
    install("alpha"),
    install("beta", { update: "2.0.0" }),
    install("gamma", { update: "1.1.0" }),
  );
  expect(read.rows.map((row) => [row.name, row.section])).toEqual([
    ["beta", "updates"],
    ["gamma", "updates"],
    ["alpha", "installed"],
  ]);
  expect(read).toMatchObject({ updates: 2, updatesText: "2 updates", updatesTitle: "2 updates" });
  expect(read.rows[0]).toMatchObject({
    meta: "Skill · 1.0.0 → 2.0.0",
    updateLabel: "Update beta to 2.0.0",
  });
});

test("an update accepted while its bot works waits for its turn and isn't offered again", () => {
  const read = answer(
    install("inbox", {
      type: "spade-bot",
      target: "bot-1",
      update: "1.1.0",
      held: { version: "1.1.0" },
    }),
  );
  expect(read).toMatchObject({ updates: 0, updatesText: null });
  expect(read.rows[0]).toMatchObject({
    section: "installed",
    update: null,
    updateLabel: null,
    notes: ["Update to 1.1.0 waits for its turn."],
  });
});

test("an update on a bot made from a package names the one bot that moves", () => {
  expect(
    only(install("inbox", { type: "spade-bot", title: "Inbox", target: "bot-1", update: "2.0.0" })),
  ).toMatchObject({
    bot: "bot-1",
    updateLabel: "Update Inbox to 2.0.0",
    updateLine: "Only Inbox moves to 2.0.0. Your other bots from this package stay as they are.",
  });
  expect(only(install("notes", { update: "2.0.0" }))?.updateLine).toBeNull();
});

test("a withdrawn entry reads off with its publisher's reason and offers Turn back on", () => {
  expect(
    only(install("digest", { state: "withdrawn", reason: "It leaked mail headers." })),
  ).toMatchObject({
    off: true,
    notes: ["Off · Withdrawn by its publisher: It leaked mail headers."],
    turnOnWord: "Turn back on",
  });
  expect(only(install("digest", { state: "withdrawn" }))?.notes).toEqual([
    "Off · Withdrawn by its publisher.",
  ]);
});

test("each state says whether it can be turned back on, and only a turned-off one in one step", () => {
  const cases: [Partial<MarketInstalled>, string | null, boolean, string[]][] = [
    [{ state: "on" }, null, false, []],
    [{ state: "off" }, "Turn back on", true, ["Off · You turned it off."]],
    [
      { state: "blocked", reason: "Matches a known stealer." },
      null,
      false,
      ["Off · ace blocked it: Matches a known stealer. Remove it."],
    ],
    [{ state: "withdrawn" }, "Turn back on", false, ["Off · Withdrawn by its publisher."]],
    [
      { state: "withdrawn", type: "spade-bot", target: "b", linked: true },
      "Resume",
      false,
      ["Off · Withdrawn by its publisher."],
    ],
  ];
  for (const [extra, word, quick, notes] of cases)
    expect(only(install("x", extra))).toMatchObject({
      turnOnWord: word,
      turnOnQuick: quick,
      notes,
    });
});

test("turning a withdrawn entry back on asks first, with its publisher's reason and the risk", () => {
  expect(
    only(
      install("digest", { title: "Digest", state: "withdrawn", reason: "It leaked mail headers" }),
    )?.turnOnAsk,
  ).toEqual({
    question: "Turn Digest back on?",
    detail:
      "Its publisher withdrew it: It leaked mail headers. It runs again at your own risk, until ace turns it off the next time it reads the Marketplace.",
    confirm: "Turn back on anyway",
  });
  expect(
    only(
      install("inbox", {
        title: "Inbox",
        type: "spade-bot",
        target: "b",
        linked: true,
        state: "withdrawn",
      }),
    )?.turnOnAsk,
  ).toEqual({
    question: "Resume Inbox?",
    detail:
      "Its publisher withdrew it without saying why. It runs again at your own risk, until ace turns it off the next time it reads the Marketplace.",
    confirm: "Resume anyway",
  });
  expect(only(install("notes", { state: "off" }))?.turnOnAsk).toBeNull();
  expect(only(install("bad", { state: "blocked" }))?.turnOnAsk).toBeNull();
});

test("Remove asks first, naming what goes", () => {
  expect(only(install("inbox", { type: "spade-bot", title: "Inbox", target: "b" }))).toMatchObject({
    removeQuestion: "Remove Inbox from Installed?",
    removeDetail:
      "Inbox and the skills and plugins it brought stay yours. It stops getting updates from the Marketplace.",
  });
  expect(only(install("harbour", { type: "suit", title: "Harbour dusk" }))).toMatchObject({
    removeQuestion: "Remove Harbour dusk?",
    removeDetail: "The Suit comes off this machine.",
  });
  expect(only(install("triage", { title: "Triage" }))?.removeDetail).toBe(
    "Your bots and agents stop seeing this skill.",
  );
});

test("a linked bot with an earlier version kept here can roll back to it", () => {
  const linked = install("inbox", {
    type: "spade-bot",
    target: "b",
    linked: true,
    previous: { version: "0.9.0", hash: "d".repeat(64) },
  });
  expect(only(linked)?.rollBackTo).toBe("0.9.0");
  expect(only(install("notes"))?.rollBackTo).toBeNull();
});

test("with nothing waiting the list says it's up to date, and empty says what shows here", () => {
  expect(answer(install("a"))).toMatchObject({
    updatesTitle: "No updates",
    upToDate: "Everything is up to date. ace checks once a day.",
    empty: null,
  });
  expect(answer()).toMatchObject({
    upToDate: null,
    empty: "What you get from the Marketplace shows here.",
  });
});

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

test("turning a withdrawn entry back on and removing another change what Installed reads", async () => {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    marketplace: {
      installed: [
        install("digest", { state: "withdrawn", reason: "Leaked headers." }),
        install("notes"),
      ],
    },
  });
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const service = new NativeMarket(client, () => 1);
  const ask = async (operation: Record<string, unknown>, fresh?: true) =>
    (await service.answer(
      NativeMarketRequest.parse({ type: "market.native", operation, fresh }),
      new AbortController().signal,
    )) as { ok: boolean; rows?: { name: string; off: boolean; notes: string[] }[] };

  expect(await ask({ op: "turnOn", type: "spade-skill", name: "digest" })).toMatchObject({
    ok: true,
  });
  expect(await ask({ op: "remove", type: "spade-skill", name: "notes" })).toMatchObject({
    ok: true,
  });
  const read = await ask({ op: "installed" }, true);
  expect(read.rows).toEqual([expect.objectContaining({ name: "digest", off: false, notes: [] })]);
});

test("the Marketplace's update count skips an update held for its bot's turn", async () => {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    marketplace: {
      installed: [
        install("inbox", {
          type: "spade-bot",
          target: "b",
          update: "1.1.0",
          held: { version: "1.1.0" },
        }),
        install("notes", { update: "2.0.0" }),
      ],
    },
  });
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const service = new NativeMarket(client, () => 1);
  const home = await service.answer(
    NativeMarketRequest.parse({ type: "market.native", operation: { op: "home" } }),
    new AbortController().signal,
  );
  expect(home).toMatchObject({ ok: true, updates: 1, updatesText: "1 update" });
});
