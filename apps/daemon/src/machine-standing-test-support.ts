import { afterAll, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GrantKeySet,
  pairedStandingText,
  standingProofText,
  encodeBase64url,
} from "@ace/account-grant";
import { aceAccountClient, AceAccountError } from "@ace/client/ace-account";
import { DeviceId, FleetResult, type ServerMessage } from "@ace/protocol";
import { SettingsService, fileIO } from "@ace/settings";
import { hostId } from "@ace/secure-channel";
import {
  fakeWorkos,
  signInThroughWorker,
  startRelayWorker,
  type WorkosUser,
} from "@ace/cloud/testing";
import { machineAccount, type MachineAccount } from "./account-access/machine-account.ts";
import { relayKeysFor } from "./account-access/relay-host-id.ts";
import { StoredSession } from "./account-access/session-file.ts";
import { redeemPairing } from "./client-access.ts";
import { setup } from "./remote-test-support.ts";
import type { Client } from "./socket-test-support.ts";

// ADR 0190 end to end: a real daemon signed in through ace's account backend (the Worker and D1
// under Miniflare, against a fake WorkOS). A process holding only what the daemon writes to
// ACE_HOME never gets the person's standing; the person, signed in in a browser, does, on the
// socket that proves it. The person-only action observed is "Ask me before agents publish",
// which the daemon changes only from a socket that proved the person's standing.

let workos: Awaited<ReturnType<typeof fakeWorkos>>;
let worker: Awaited<ReturnType<typeof startRelayWorker>>;
let personKeys: GrantKeySet;
/** Starts ace's account backend for this test file (each file gets its own). */
export function useAccountBackend() {
  beforeAll(async () => {
    workos = await fakeWorkos();
    worker = await startRelayWorker({ workosUrl: workos.url });
    personKeys = GrantKeySet.parse(await (await fetch(`${worker.http}/v1/keys`)).json());
  });
  afterAll(async () => {
    await worker?.close();
    await workos?.close();
  });
  return {
    get workos() {
      return workos;
    },
    get worker() {
      return worker;
    },
    get personKeys() {
      return personKeys;
    },
  };
}

export const person: WorkosUser = {
  id: "user_p",
  email: "p@example.com",
  first_name: "Pat",
  last_name: null,
  email_verified: true,
};
/** Someone else's ace account: whoever reads ACE_HOME, signed in in their own browser. */
export const other: WorkosUser = {
  id: "user_q",
  email: "q@example.com",
  first_name: "Quinn",
  last_name: null,
  email_verified: true,
};
export const signal = () => AbortSignal.timeout(15_000);
export const accounts = () => aceAccountClient({ origin: worker.http, fetch: globalThis.fetch });
export const sessionFile = (home: string) => join(home, "ace-account.json");
export const stored = async (home: string) =>
  StoredSession.parse(JSON.parse(await readFile(sessionFile(home), "utf8")));
export const backendKnows = async (token: string) => {
  try {
    await accounts().session(token, signal());
    return true;
  } catch (error) {
    if (error instanceof AceAccountError && error.status === 401) return false;
    throw error;
  }
};

/** A device's P-256 key, made as the web app makes one. */
export async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const raw = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const sign = async (text: string) =>
    encodeBase64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(text),
        ),
      ),
    );
  return { raw, sign };
}

export async function answer<T extends ServerMessage["type"]>(client: Client, type: T) {
  for (;;) {
    const message: ServerMessage = await client.next();
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
}

/** Tries to turn "Ask me before agents publish" off: true when the daemon let this socket. */
export async function changesGuardedSetting(client: Client): Promise<boolean> {
  client.send({
    type: "settings.set",
    requestId: "ask",
    key: "market.askBeforeAgentPublish",
    value: false,
    layer: { kind: "global" },
  });
  return (await answer(client, "settings.result")).ok;
}

/** The same, as one of a batch of writes (`settings.setMany`): true when the daemon let it. */
export async function changesGuardedSettingInBatch(client: Client): Promise<boolean> {
  client.send({
    type: "settings.setMany",
    requestId: "ask-batch",
    entries: [
      { key: "logs.maxBytes", value: 10_000_000 },
      { key: "market.askBeforeAgentPublish", value: true },
    ],
    layer: { kind: "global" },
  });
  return (await answer(client, "settings.result")).ok;
}

/** Proves the person's standing on `client` with `grant` and `proof`: true when it took. */
export async function proves(client: Client, grant: string, proof: string): Promise<boolean> {
  client.send({ type: "account.standing", requestId: "standing", grant, proof });
  return (await answer(client, "account.standing.result")).result.ok;
}

/** A daemon on ace's account backend, trusting the backend's keys as a build pins its own. */
export async function daemon() {
  let account: MachineAccount | undefined;
  let home = "";
  let settings: SettingsService | undefined;
  const f = await setup({}, (store, dir) => {
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
  if (!account) throw new Error("No machine account");
  const machine = account;
  const keys = await relayKeysFor(home);
  const host = hostId(keys.publicKey);

  /** An account device's socket, its grant minted with `token` for this daemon. */
  async function accountSocket(token: string, key?: Awaited<ReturnType<typeof deviceKey>>) {
    const grant = await accounts().grant(
      token,
      { kind: "device", subject: "phone", host, ...(key ? { key: key.raw } : {}) },
      signal(),
    );
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("phone"),
      grant: grant.token,
    });
    const welcome = await answer(client, "welcome");
    if (!welcome.standingNonce) throw new Error("No standing nonce");
    return { client, grant, nonce: welcome.standingNonce };
  }
  /** The app's own page: a host-token socket on loopback, its nonce and host from its welcome. */
  async function pageSocket() {
    const client = await f.connect();
    const welcome = await answer(client, "welcome");
    if (!welcome.standingNonce || !welcome.standingHost) throw new Error("No standing challenge");
    return { client, nonce: welcome.standingNonce, host: welcome.standingHost };
  }
  return {
    f,
    account: machine,
    home,
    host,
    keys,
    accountSocket,
    pageSocket,
    close: async () => {
      await machine.close();
      settings?.close();
    },
  };
}

/** The app signed in in the person's browser hands its daemon an enrollment ticket. */
export async function signedInDaemon() {
  const session = await signInThroughWorker(worker.http, workos, person);
  const machine = await daemon();
  await machine.account.load();
  const { ticket } = await accounts().machineEnrollment(session.token, machine.host, signal());
  await machine.account.handover(worker.http, { ticket });
  return { ...machine, session };
}

/** A paired device's welcomed socket, from a pairing redeemed with `pair`. */
export async function pairedSocket(
  f: Awaited<ReturnType<typeof daemon>>["f"],
  pair: () => Promise<{ token: string; device: { id: string } }>,
) {
  return (await pairedChallenge(f, pair)).client;
}

/** A paired device's welcomed socket and the standing challenge its welcome gave. */
export async function pairedChallenge(
  f: Awaited<ReturnType<typeof daemon>>["f"],
  pair: () => Promise<{ token: string; device: { id: string } }>,
) {
  const paired = await pair();
  const ticket = await f.ticket(paired.token);
  const client = await f.connectTicket(paired.device.id, ticket.ticket);
  const welcome = await answer(client, "welcome");
  if (!welcome.standingNonce || !welcome.standingHost) throw new Error("No standing challenge");
  return {
    client,
    device: paired.device.id,
    nonce: welcome.standingNonce,
    host: welcome.standingHost,
  };
}

/** A paired device proves the person's standing with `proof`: true when it took. */
export async function provesPaired(client: Client, proof: string): Promise<boolean> {
  client.send({ type: "device.standing", requestId: "paired", proof });
  return (await answer(client, "account.standing.result")).result.ok;
}

/** A device paired from `url` with `key`, its socket proven with that key: the person? */
export async function pairedPerson(
  f: Awaited<ReturnType<typeof daemon>>["f"],
  url: string,
): Promise<{ bearer: boolean; proven: boolean }> {
  const key = await deviceKey();
  const paired = await pairedChallenge(f, () => redeemPairing(url, "Phone", undefined, key.raw));
  const bearer = await changesGuardedSetting(paired.client);
  const proof = await key.sign(
    pairedStandingText({
      host: paired.host,
      nonce: paired.nonce,
      binding: undefined,
      deviceId: paired.device,
    }),
  );
  return {
    bearer,
    proven:
      (await provesPaired(paired.client, proof)) && (await changesGuardedSetting(paired.client)),
  };
}

/** A pairing link made over `client`'s socket (`fleet.request`). */
export async function linkFrom(client: Client): Promise<string> {
  client.send({
    type: "fleet.request",
    requestId: "pair",
    operation: { op: "pairing", scopes: ["read", "operate", "admin"] },
  });
  const issued = FleetResult.shape.result.parse((await answer(client, "fleet.result")).result);
  if (issued.kind !== "pairing") throw new Error("No pairing issued");
  return issued.url;
}

/** The person proves their standing on the app's page socket: true when it took. */
export async function pageProves(
  daemonHome: Awaited<ReturnType<typeof signedInDaemon>>,
  session: string,
): Promise<{ client: Client; ok: boolean }> {
  const key = await deviceKey();
  const page = await daemonHome.pageSocket();
  const minted = await accounts().grant(
    session,
    { kind: "device", subject: "device", host: page.host, key: key.raw },
    signal(),
  );
  const grant = minted.standing ?? "";
  const proof = await key.sign(
    standingProofText({ host: page.host, nonce: page.nonce, binding: undefined, grant }),
  );
  return { client: page.client, ok: await proves(page.client, grant, proof) };
}
