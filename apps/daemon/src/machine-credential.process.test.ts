import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GrantKeySet, verifyStandingGrant } from "@ace/account-grant";
import { aceAccountClient, AceAccountError } from "@ace/client/ace-account";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import type { AceAccountGrant } from "@ace/protocol/ace-account";
import { SettingsService, fileIO } from "@ace/settings";
import {
  fakeWorkos,
  signInThroughWorker,
  startRelayWorker,
  type WorkosUser,
} from "@ace/cloud/testing";
import { machineAccount, type MachineAccount } from "./account-access/machine-account.ts";
import { relayHostIdFor, relayKeysFor } from "./account-access/relay-host-id.ts";
import { StoredSession } from "./account-access/session-file.ts";
import { fixture } from "./socket-test-support.ts";

// ADR 0190 end to end: a real daemon signed in through ace's account backend (the Worker and D1
// under Miniflare, against a fake WorkOS). A process holding only what the daemon writes to
// ACE_HOME never gets the person's standing; the person, signed in in a browser, does. The
// person-only action observed is "Ask me before agents publish", which the daemon refuses to
// change for a credential that isn't the person's without a fresh sign-in (ADR 0178 §12.7).

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startRelayWorker>>;
let personKeys: GrantKeySet;
beforeAll(async () => {
  workos = await fakeWorkos();
  worker = await startRelayWorker({ workosUrl: workos.url });
  personKeys = GrantKeySet.parse(await (await fetch(`${worker.http}/v1/keys`)).json());
});
afterAll(async () => {
  await worker?.close();
  await workos?.close();
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const person: WorkosUser = {
  id: "user_p",
  email: "p@example.com",
  first_name: "Pat",
  last_name: null,
};
const signal = () => AbortSignal.timeout(15_000);
const accounts = () => aceAccountClient({ origin: worker.http, fetch: globalThis.fetch });
const sessionFile = (home: string) => join(home, "ace-account.json");
const stored = async (home: string) =>
  StoredSession.parse(JSON.parse(await readFile(sessionFile(home), "utf8")));
const backendKnows = async (token: string) => {
  try {
    await accounts().session(token, signal());
    return true;
  } catch (error) {
    if (error instanceof AceAccountError && error.status === 401) return false;
    throw error;
  }
};

/** A daemon on ace's account backend, trusting the backend's keys as a build pins its own. */
async function daemon() {
  let account: MachineAccount | undefined;
  let home = "";
  let settings: SettingsService | undefined;
  const f = await fixture({}, (store, dir) => {
    home = dir;
    settings = new SettingsService({
      dataDir: dir,
      io: { ...fileIO, watch: async () => () => {} },
    });
    account = machineAccount({
      relayKeys: () => relayKeysFor(dir),
      personKeys,
      dataDir: dir,
      codes: store.machineCodes,
      fetch: globalThis.fetch,
      now: Date.now,
      randomBytes,
      delay: () => () => {},
    });
    return { machineAccount: account, settings };
  });
  cleanup.push(async () => {
    await account?.close();
    settings?.close();
    await f.close();
  });
  if (!account) throw new Error("No machine account");
  const machine = account;

  /**
   * A device on the account says hello on a direct socket with a grant `token` minted, then
   * tries to turn "Ask me before agents publish" off. True when the daemon let it.
   */
  async function actsAsPerson(token: string, options: { withStanding?: boolean } = {}) {
    const grant = await accounts().grant(token, { kind: "device", subject: "phone" }, signal());
    return helloActsAsPerson(options.withStanding === false ? { token: grant.token } : grant);
  }
  /** `actsAsPerson` with a grant (and its standing grant, if any) already in hand. */
  async function helloActsAsPerson(grant: { token: string; standing?: string | undefined }) {
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("phone"),
      grant: grant.token,
      ...(grant.standing ? { standing: grant.standing } : {}),
    });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    client.send({
      type: "settings.set",
      requestId: "ask",
      key: "market.askBeforeAgentPublish",
      value: false,
      layer: { kind: "global" },
    });
    let answer: ServerMessage;
    do answer = await client.next();
    while (answer.type !== "settings.result");
    await client.close();
    return answer.ok;
  }
  return { account: machine, home, actsAsPerson, helloActsAsPerson };
}

/** The app signed in in the person's browser hands its session to the daemon. */
async function signedInDaemon() {
  const session = await signInThroughWorker(worker.http, workos, person);
  const machine = await daemon();
  await machine.account.handover(worker.http, { token: session.token });
  return { ...machine, session };
}

it("a process that reads ace-account.json can't act as the person", async () => {
  const { home, session, actsAsPerson } = await signedInDaemon();
  const text = await readFile(sessionFile(home), "utf8");
  // What the daemon wrote is its machine credential; the person's session never reaches disk.
  expect(text).not.toContain(session.token);
  const file = await stored(home);
  expect(file.kind).toBe("machine");
  // A same-user process reads the file, mints itself a device grant and connects as an account
  // device: it has admin, but not the person's standing, with or without the standing grant.
  expect(await actsAsPerson(file.token)).toBe(false);
  expect(await actsAsPerson(file.token, { withStanding: false })).toBe(false);
  // Nor can it trade the credential for anything that would.
  await expect(
    accounts().machineCredential(file.token, { hostId: await relayHostIdFor(home) }, signal()),
  ).rejects.toMatchObject({ status: 403 });
});

it("the person signing in in a browser acts as the person from their device", async () => {
  const { session, actsAsPerson } = await signedInDaemon();
  expect(await actsAsPerson(session.token)).toBe(true);
  // An older client that leaves the standing grant out has a machine's standing.
  expect(await actsAsPerson(session.token, { withStanding: false })).toBe(false);
});

it("a machine credential's device grants never give person standing", async () => {
  const { account, home, helloActsAsPerson } = await signedInDaemon();
  const file = await stored(home);
  const minted = await accounts().grant(file.token, { kind: "device", subject: "phone" }, signal());
  if (!minted.standing) throw new Error("No standing grant");
  expect(verifyStandingGrant(minted.standing, personKeys, Date.now()).standing).toBe("machine");
  // The device grant the daemon itself takes to reach another machine (ADR 0182) is one too.
  expect(await helloActsAsPerson({ token: await account.deviceGrant("phone") })).toBe(false);
});

it("an existing session file is exchanged once and removed", async () => {
  // An older daemon's `ace login` left the person's session in its file.
  const session: AceAccountGrant = await signInThroughWorker(worker.http, workos, person);
  const { account, home, actsAsPerson } = await daemon();
  await writeFile(
    sessionFile(home),
    JSON.stringify({ origin: worker.http, ...session, source: "login" }),
    { mode: 0o600 },
  );
  await account.load();
  await expect.poll(async () => (await stored(home)).kind, { timeout: 10_000 }).toBe("machine");
  const exchanged = await stored(home);
  expect(await readFile(sessionFile(home), "utf8")).not.toContain(session.token);
  expect(account.status()).toMatchObject({ signedIn: true, account: { id: "user_p" } });
  expect(account.status().signInAgain).toBeUndefined();
  // Whoever copied the file before the upgrade holds a token that no longer works.
  expect(await backendKnows(session.token)).toBe(false);
  expect(await backendKnows(exchanged.token)).toBe(true);
  // Once: a restart reads the credential and keeps it.
  await account.load();
  await account.renew();
  expect((await stored(home)).token).toBe(exchanged.token);
  expect(await actsAsPerson(exchanged.token)).toBe(false);
});

it("a session file the app handed over is exchanged, and that session never speaks for the person again", async () => {
  const session = await signInThroughWorker(worker.http, workos, person);
  const { account, home, actsAsPerson } = await daemon();
  await writeFile(
    sessionFile(home),
    JSON.stringify({ origin: worker.http, ...session, source: "handover" }),
    { mode: 0o600 },
  );
  await account.load();
  await expect.poll(async () => (await stored(home)).kind, { timeout: 10_000 }).toBe("machine");
  // The app still holds the session, so it keeps working; but it was on this disk.
  expect(await backendKnows(session.token)).toBe(true);
  expect(await actsAsPerson(session.token)).toBe(false);
  // Signing in again in the browser gives the app a session that is the person's.
  const again = await signInThroughWorker(worker.http, workos, person);
  expect(await actsAsPerson(again.token)).toBe(true);
});
