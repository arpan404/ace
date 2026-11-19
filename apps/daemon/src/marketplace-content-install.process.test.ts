import { DeviceId, type ServerMessage } from "@ace/protocol";
import { appSocketProof } from "@ace/service/app-key";
import type { ArchiveFile } from "@ace/marketplace";
import {
  folder,
  sampleSkill,
  samplePlugin,
  sampleRecipe,
  sampleSuit,
  signedVersion,
} from "@ace/marketplace/testing";
import type { MarketEntryType } from "@ace/protocol/marketplace";
import { afterEach, expect, test } from "vitest";
import {
  fakeMarket,
  fakeSpade,
  gitCatalog,
  marketplaceHarness,
} from "./marketplace/test-support.ts";
import { fixture, token, type Client } from "./socket-test-support.ts";

/*
 * Installing content only over the host token (ADR 0178 §12.8): a real daemon socket holding
 * only the token file, with no ace account at all, so no sign-in can be fresh. A Suit and a Spade
 * skill install; a plugin, and a skill carrying an executable file, still need the sign-in. A
 * real socket: the exemption is decided on the daemon's own review of bytes it fetched, which
 * only a prepared review behind the socket has.
 */

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

const none = { bots: [], needs: {}, startRoutines: false };
const reauth = { op: "error", code: "reauth" };

async function world() {
  const market = await fakeMarket();
  cleanup.push(() => market.close());
  const spade = await fakeSpade();
  cleanup.push(() => spade.close());
  const harness = await marketplaceHarness({ origin: market.origin, spade });
  cleanup.push(() => harness.close());
  // The key the app would give its daemon: a socket that proves it is the person's.
  const appKey = new Uint8Array(32).fill(5);
  const f = await fixture({ marketplace: harness.service, appKey });
  cleanup.push(() => f.close());
  const port = Number(new URL(f.server.url).port);
  /** A socket on the host token; with `person`, also the app's proof. */
  const socket = async (person: boolean) => {
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(person ? "desktop-page" : "ace-cli"),
      token,
      ...(person ? { appProof: appSocketProof(appKey, port) } : {}),
    });
    await until(client, (message) => message.type === "welcome");
    let requests = 0;
    return async (operation: unknown) => {
      const requestId = `r${++requests}`;
      client.socket.send(JSON.stringify({ type: "marketplace.request", requestId, operation }));
      const answer = await until(
        client,
        (message) => message.type === "marketplace.result" && message.requestId === requestId,
      );
      return answer.type === "marketplace.result" ? answer.result : undefined;
    };
  };
  const ask = await socket(false);
  const person = await socket(true);
  const publish = (type: MarketEntryType, name: string, files: ArchiveFile[], version?: string) =>
    market.publish(signedVersion({ type, name, files, ...(version ? { version } : {}) }), files);
  /** Review `type/name` from `source` over the host token. */
  const prepare = async (type: MarketEntryType, name: string, source = "market") => {
    const prepared = await ask({ op: "prepare", source, type, name });
    if (prepared?.op !== "review") throw new Error(`No review: ${JSON.stringify(prepared)}`);
    return prepared.review;
  };
  /** Publish `files` as `type/name`, review it over the socket, and install that review. */
  const install = async (type: MarketEntryType, name: string, files: ArchiveFile[]) => {
    publish(type, name, files);
    const review = await prepare(type, name);
    return ask({ op: "install", id: review.id, hash: review.hash, choices: none });
  };
  /** The market skills Spade would give bots, by name and hash. */
  const forBots = async () => {
    const listed = await ask({ op: "spadeSkills" });
    return listed?.op === "spadeSkills"
      ? listed.skills.map(({ name, hash }) => ({ name, hash }))
      : [];
  };
  /** A git catalog of this test's, holding `files` as the Suit `name`: its source id. */
  const catalog = async (name: string, files: ArchiveFile[]) => {
    const repo = await gitCatalog(
      harness.root,
      {
        name: "elsewhere",
        plugins: [],
        entries: [{ type: "suit", name, source: "suits/one", title: "Harbour dusk" }],
      },
      { "suits/one": files },
    );
    const added = await ask({ op: "addSource", address: repo });
    const git =
      added?.op === "sources" ? added.sources.find((source) => source.kind === "git") : undefined;
    if (!git) throw new Error(`No git source: ${JSON.stringify(added)}`);
    return git.id;
  };
  return { ask, person, install, publish, prepare, forBots, catalog, socket };
}

async function until(client: Client, match: (message: ServerMessage) => boolean) {
  for (;;) {
    const message = await client.next();
    if (match(message)) return message;
  }
}

test("a host-token socket installs a Suit and a Spade skill with no fresh sign-in", async () => {
  const { install } = await world();
  expect(await install("suit", "harbour-dusk", sampleSuit())).toMatchObject({ op: "done" });
  expect(await install("spade-skill", "triage-mail", sampleSkill())).toMatchObject({
    op: "done",
  });
});

test("installing a bot, a plugin, or a skill carrying an executable file, still needs the sign-in", async () => {
  const { install, publish } = await world();
  expect(await install("spade-plugin", "mail-tools", samplePlugin())).toMatchObject(reauth);
  const runnable = [
    ...sampleSkill("sort-mail"),
    ...folder({ "scripts/sort.sh*": "#!/bin/sh\nexit 0\n" }),
  ];
  expect(await install("spade-skill", "sort-mail", runnable)).toMatchObject(reauth);
  // A bot that brings only content still makes a bot, which runs on its own.
  publish("spade-skill", "triage-mail", sampleSkill());
  expect(await install("spade-bot", "inbox", sampleRecipe({ plugins: [] }))).toMatchObject(reauth);
});

test("a skill a host-token socket installs or updates reaches no bot until the person turns that version on", async () => {
  const { ask, person, install, publish, forBots } = await world();
  expect(await install("spade-skill", "triage-mail", sampleSkill())).toMatchObject({ op: "done" });
  expect(await forBots()).toEqual([]);
  const installed = await ask({ op: "installed" });
  expect(installed).toMatchObject({ installed: [{ name: "triage-mail", botsApproved: false }] });
  const first = installed?.op === "installed" ? (installed.installed[0]?.hash ?? "") : "";

  // Turning it on is the person's: the host token alone can't.
  expect(await ask({ op: "turnOnForBots", name: "triage-mail", hash: first })).toMatchObject(
    reauth,
  );
  expect(await person({ op: "turnOnForBots", name: "triage-mail", hash: first })).toMatchObject({
    op: "done",
  });
  expect(await forBots()).toEqual([{ name: "triage-mail", hash: first }]);

  // An update over the host token installs, and takes the skill from bots until it's turned on.
  publish(
    "spade-skill",
    "triage-mail",
    sampleSkill("triage-mail", { "refs/rules.md": "two" }),
    "1.1.0",
  );
  await ask({ op: "refresh" });
  const update = await ask({ op: "prepareUpdate", type: "spade-skill", name: "triage-mail" });
  if (update?.op !== "review") throw new Error("Expected a review of the update");
  expect(
    await ask({ op: "install", id: update.review.id, hash: update.review.hash, choices: none }),
  ).toMatchObject({ op: "done" });
  expect(await forBots()).toEqual([]);
  // The version the person turned on before is not the one installed now.
  expect(await person({ op: "turnOnForBots", name: "triage-mail", hash: first })).toMatchObject({
    code: "conflict",
  });
  expect(
    await person({ op: "turnOnForBots", name: "triage-mail", hash: update.review.hash }),
  ).toMatchObject({ op: "done" });
  expect(await forBots()).toEqual([{ name: "triage-mail", hash: update.review.hash }]);
});

test("a skill the person installs is on for their bots at once", async () => {
  const { person, publish, forBots } = await world();
  publish("spade-skill", "triage-mail", sampleSkill());
  const prepared = await person({
    op: "prepare",
    source: "market",
    type: "spade-skill",
    name: "triage-mail",
  });
  if (prepared?.op !== "review") throw new Error("Expected a review");
  expect(
    await person({
      op: "install",
      id: prepared.review.id,
      hash: prepared.review.hash,
      choices: none,
    }),
  ).toMatchObject({ op: "done" });
  expect(await forBots()).toEqual([{ name: "triage-mail", hash: prepared.review.hash }]);
});

test("a Suit updates from the same source over the host token with no sign-in", async () => {
  const { ask, install, publish } = await world();
  expect(await install("suit", "harbour-dusk", sampleSuit())).toMatchObject({ op: "done" });
  // The same Suit with a warmer lamp, as its publisher's next version.
  const next = sampleSuit();
  for (const file of next)
    if (file.path === "suit.json")
      file.content = new TextEncoder().encode(
        new TextDecoder().decode(file.content).replace("a warm lamp", "a warmer lamp"),
      );
  publish("suit", "harbour-dusk", next, "2.0.0");
  await ask({ op: "refresh" });
  const update = await ask({ op: "prepareUpdate", type: "suit", name: "harbour-dusk" });
  if (update?.op !== "review") throw new Error(`Expected a review: ${JSON.stringify(update)}`);
  expect(
    await ask({ op: "install", id: update.review.id, hash: update.review.hash, choices: none }),
  ).toMatchObject({ op: "done" });
});

test("an install whose id or hash doesn't match an open review gets no exemption", async () => {
  const { ask, publish, prepare } = await world();
  publish("suit", "harbour-dusk", sampleSuit());
  const review = await prepare("suit", "harbour-dusk");
  expect(
    await ask({ op: "install", id: review.id, hash: "f".repeat(64), choices: none }),
  ).toMatchObject(reauth);
  expect(
    await ask({ op: "install", id: "rv-unknown", hash: review.hash, choices: none }),
  ).toMatchObject(reauth);
});

test("a same-name Suit from another catalog replacing a signed install is the person's", async () => {
  const { ask, person, install, prepare, catalog } = await world();
  expect(await install("suit", "harbour-dusk", sampleSuit())).toMatchObject({ op: "done" });
  const review = await prepare("suit", "harbour-dusk", await catalog("harbour-dusk", sampleSuit()));
  const replace = { op: "install", id: review.id, hash: review.hash, choices: none };
  expect(await ask(replace)).toMatchObject(reauth);
  expect(await person(replace)).toMatchObject({ op: "done" });
});

test("removing an install doesn't make its name new: reinstalling from another catalog is the person's", async () => {
  const { ask, person, install, prepare, catalog } = await world();
  expect(await install("suit", "harbour-dusk", sampleSuit())).toMatchObject({ op: "done" });
  expect(await ask({ op: "remove", type: "suit", name: "harbour-dusk" })).toMatchObject({
    op: "done",
  });
  const review = await prepare("suit", "harbour-dusk", await catalog("harbour-dusk", sampleSuit()));
  const reinstall = { op: "install", id: review.id, hash: review.hash, choices: none };
  expect(await ask(reinstall)).toMatchObject(reauth);
  expect(await person(reinstall)).toMatchObject({ op: "done" });
});

test("two installs of one name from two sources at once: the second is judged against the first", async () => {
  const { ask, publish, prepare, catalog, socket } = await world();
  publish("suit", "harbour-dusk", sampleSuit());
  // Both reviewed while nothing of that name is installed, so both pass the gate.
  const fromMarket = await prepare("suit", "harbour-dusk");
  const fromGit = await prepare(
    "suit",
    "harbour-dusk",
    await catalog("harbour-dusk", sampleSuit()),
  );
  const other = await socket(false);
  const results = await Promise.all([
    ask({ op: "install", id: fromMarket.id, hash: fromMarket.hash, choices: none }),
    other({ op: "install", id: fromGit.id, hash: fromGit.hash, choices: none }),
  ]);
  expect(results.filter((result) => result?.op === "done")).toHaveLength(1);
  expect(
    results.filter((result) => result?.op === "error" && result.code === "reauth"),
  ).toHaveLength(1);
});

test("reinstalling the very bytes of an approved skill over the host token keeps it on for bots", async () => {
  const { ask, person, publish, prepare, forBots } = await world();
  publish("spade-skill", "triage-mail", sampleSkill());
  const first = await prepare("spade-skill", "triage-mail");
  expect(
    await person({ op: "install", id: first.id, hash: first.hash, choices: none }),
  ).toMatchObject({ op: "done" });
  const again = await prepare("spade-skill", "triage-mail");
  expect(again.hash).toBe(first.hash);
  expect(await ask({ op: "install", id: again.id, hash: again.hash, choices: none })).toMatchObject(
    { op: "done" },
  );
  expect(await forBots()).toEqual([{ name: "triage-mail", hash: first.hash }]);
});
