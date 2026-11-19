import { CommandId, DeviceId, InteractionId, type ServerMessage } from "@ace/protocol";
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
import { DatabaseSync } from "node:sqlite";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { signInThroughWorker } from "@ace/cloud/testing";
import { standingProofText } from "@ace/account-grant";
import { hostId } from "@ace/secure-channel";
import { relayKeysFor } from "./account-access/relay-host-id.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { hostConnection } from "./cli/connection.ts";
import { accessRequest } from "./client-access.ts";
import {
  accounts,
  answer,
  deviceKey,
  pageProves,
  person as personUser,
  proves,
  signal,
  signedInDaemon,
  useAccountBackend,
} from "./machine-standing-test-support.ts";
import {
  fakeMarket,
  fakeSpade,
  gitCatalog,
  marketplaceHarness,
} from "./marketplace/test-support.ts";
import { Client } from "./socket-test-support.ts";

/*
 * Installing content only over the host token (ADR 0178 §12.8, ADR 0190): a real daemon signed in
 * through ace's account backend, a socket holding only the token file, and the app's page that
 * proved the person's standing. A Suit and a Spade skill install over the token; a skill so
 * installed reaches no bot until the person turns that version on; a bot, a plugin, a skill
 * carrying an executable file, and a replacement from elsewhere are the person's. A real socket:
 * the exemption is decided on the daemon's own review of bytes it fetched, which only a prepared
 * review behind the socket has, and the person's standing only on a socket that proved it.
 */

const accountBackend = useAccountBackend();

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

const none = { bots: [], needs: {}, startRoutines: false };
const reauth = { op: "error", code: "reauth" };

/** Asks `client`'s socket market requests, one at a time. */
const asker = (client: Client) => {
  let requests = 0;
  return async (operation: unknown) => {
    const requestId = `r${++requests}`;
    client.socket.send(JSON.stringify({ type: "marketplace.request", requestId, operation }));
    const reply = await until(
      client,
      (message) => message.type === "marketplace.result" && message.requestId === requestId,
    );
    return reply.type === "marketplace.result" ? reply.result : undefined;
  };
};

async function world() {
  const market = await fakeMarket();
  cleanup.push(() => market.close());
  const spade = await fakeSpade();
  cleanup.push(() => spade.close());
  const harness = await marketplaceHarness({ origin: market.origin, spade });
  cleanup.push(() => harness.close());
  const signedIn = await signedInDaemon({ marketplace: harness.service });
  cleanup.push(() => signedIn.close());
  /** Another socket holding only the host token, as any process that read it can open. */
  const socket = async () => {
    const client = await signedIn.f.connect();
    await until(client, (message) => message.type === "welcome");
    return asker(client);
  };
  const ask = await socket();
  // The app's page, signed in as the person in their browser, proves their standing (ADR 0190).
  const page = await pageProves(signedIn, signedIn.session.token);
  if (!page.ok) throw new Error("The page didn't prove the person's standing");
  const person = asker(page.client);
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

/** One market request on `client`, in `thread` when an agent's shell names one; its result. */
const market = async (client: Client, requestId: string, operation: unknown, thread?: string) => {
  client.socket.send(
    JSON.stringify({
      type: "marketplace.request",
      requestId,
      operation,
      ...(thread ? { thread } : {}),
    }),
  );
  const result = await until(
    client,
    (message) => message.type === "marketplace.result" && message.requestId === requestId,
  );
  return result.type === "marketplace.result" ? result.result : undefined;
};

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
  const other = await socket();
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

test("an agent asking in its thread to turn a skill on for bots waits for the person's proven page", async () => {
  const { worker, workos, personKeys } = accountBackend;
  const f = await daemonFixture(undefined, { personGrantKeys: personKeys }, {});
  cleanup.push(() => f.daemon.close());
  // The account backend's grants are on the wall clock; the daemon checks them on its own.
  f.h.clock.time = Date.now();
  await f.daemon.settings.set("beta.marketplace", true, { kind: "global" });
  await f.daemon.settings.set("remote.enabled", false, { kind: "global" });
  const home = join(f.h.home, "daemon");
  // A skill a caller without the person installed over the host token: waiting for the person.
  const hash = "c".repeat(64);
  const registry = new DatabaseSync(join(await realpath(home), "marketplace", "registry.sqlite"));
  registry.prepare("INSERT INTO installs (type, name, data) VALUES (?, ?, ?)").run(
    "spade-skill",
    "triage-mail",
    JSON.stringify({
      source: "market",
      type: "spade-skill",
      name: "triage-mail",
      title: "Triage mail",
      version: "1.0.0",
      hash,
      acceptedAt: Date.now(),
      state: "on",
      files: [],
      description: "Sorts mail.",
      signed: true,
      approvedHash: null,
    }),
  );
  registry.close();

  // The person signs the app in in their browser; the app hands its daemon the enrollment.
  const session = await signInThroughWorker(worker.http, workos, personUser);
  const host = hostId((await relayKeysFor(home)).publicKey);
  const { ticket } = await accounts().machineEnrollment(session.token, host, signal());
  const { origin, token } = hostConnection(home);
  await accessRequest(origin, "/v1/ace-account", {
    method: "PUT",
    token,
    body: { origin: worker.http, ticket },
  });

  /** A welcomed socket on the host token, as `deviceId`. */
  const connect = async (deviceId: string) => {
    const client = new Client(origin.replace("http:", "ws:"));
    cleanup.push(() => client.close());
    await new Promise((resolve) => client.socket.once("open", resolve));
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse(deviceId), token });
    return { client, welcome: await answer(client, "welcome") };
  };
  // The app's page proves the person's standing, as the person signed in in their browser.
  const page = await connect("desktop-page");
  const key = await deviceKey();
  const minted = await accounts().grant(
    session.token,
    {
      kind: "device",
      subject: "desktop-page",
      host: page.welcome.standingHost ?? "",
      key: key.raw,
    },
    signal(),
  );
  const grant = minted.standing ?? "";
  const proof = await key.sign(
    standingProofText({
      host: page.welcome.standingHost ?? "",
      nonce: page.welcome.standingNonce ?? "",
      binding: undefined,
      grant,
    }),
  );
  expect(await proves(page.client, grant, proof)).toBe(true);
  const tokenOnly = await connect("ace-cli");
  const agent = await connect("ace-agent");

  const forBots = async () => {
    const listed = await market(tokenOnly.client, `bots-${Date.now()}`, { op: "spadeSkills" });
    return listed?.op === "spadeSkills" ? listed.skills.map((skill) => skill.name) : [];
  };
  expect(await forBots()).toEqual([]);

  // The agent asks in its thread: turning a skill on for bots is the person's, so it becomes
  // the person-only request there.
  const asked = await market(
    agent.client,
    "ask",
    { op: "turnOnForBots", name: "triage-mail", hash },
    f.caller.threadId,
  );
  expect(asked).toMatchObject({ op: "error", code: "person_only" });
  const request = asked?.op === "error" ? (asked.request ?? "") : "";

  const resolve = async (client: Client, deviceId: string, id: string) => {
    client.send({
      type: "command",
      command: {
        id: CommandId.parse(id),
        deviceId: DeviceId.parse(deviceId),
        payload: {
          type: "interaction.resolve",
          interactionId: InteractionId.parse(request),
          resolution: { kind: "approval", optionId: "run" },
        },
      },
    });
    return until(
      client,
      (message) =>
        (message.type === "commandResult" && message.commandId === id) ||
        (message.type === "error" && message.commandId === id),
    );
  };
  // The host token alone can't answer it.
  expect(await resolve(tokenOnly.client, "ace-cli", "by-token")).toMatchObject({
    type: "error",
    code: "reauth",
  });
  expect(await forBots()).toEqual([]);
  // The person's proven page answers it, and that version reaches the bots.
  expect(await resolve(page.client, "desktop-page", "by-page")).toMatchObject({
    type: "commandResult",
    ok: true,
  });
  await expect.poll(forBots, { timeout: 10_000 }).toEqual(["triage-mail"]);
});
