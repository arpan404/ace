import { afterEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRANT_LIFETIME_MS, signGrant } from "@ace/account-grant";
import { connectClientViaRelay, startRelay, type ClientChannel } from "@ace/relay";
import { hostId, keyPair } from "@ace/secure-channel";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { Store } from "./store.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { startFilesRelay } from "./files-relay.ts";
import { machineAccount } from "./account-access/machine-account.ts";
import { CODE_LOCK_MS } from "./account-access/machine-code-policy.ts";
import { StoredSession } from "./account-access/session-file.ts";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";
import { fixture, token } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function signedInDaemon() {
  let offset = 0;
  const now = () => Date.now() + offset;
  const backend = await startFakeAccountBackend(now);
  cleanup.push(() => backend.close());
  const signingKey = backend.signingKey;
  const root = await mkdtemp(join(tmpdir(), "ace-account-access-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.sqlite"));
  cleanup.push(() => store.close());
  const auth = new RemoteAuth(store.devices, "f".repeat(64), { now, secret: randomUUID });
  const account = machineAccount({
    dataDir: root,
    codes: store.machineCodes,
    fetch: globalThis.fetch,
    now,
    randomBytes,
    delay: (run, milliseconds) => {
      const timer = setTimeout(run, milliseconds);
      return () => clearTimeout(timer);
    },
  });
  cleanup.push(() => account.close());
  await account.handover(backend.origin, backend.token);
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const keys = keyPair();
  const host = await startFilesRelay({
    url: relay.url,
    keys,
    auth,
    devices: store.devices,
    hostId: "host-1",
    headSeq: () => 0,
    account,
    relayAccount: {
      grant: (signal) => account.machineGrant(hostId(keys.publicKey), signal),
      name: "Office Mac",
      platform: "darwin",
    },
  });
  cleanup.push(() => host.close());

  const deviceGrant = (claims: { account?: string; subject?: string; iat?: number } = {}) => {
    const iat = claims.iat ?? now();
    return signGrant(
      {
        kind: "device",
        account: claims.account ?? "user_a",
        subject: claims.subject ?? "phone",
        iat,
        exp: iat + GRANT_LIFETIME_MS,
      },
      signingKey,
    );
  };
  /** Open a provider sign-in channel as an account device; resolves with the daemon's first answer. */
  async function open(hello: { grant?: string; deviceId?: string; machineCode?: string } = {}) {
    const client = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId: host.hostId,
      pinnedFingerprint: host.hostId,
      grant: "device-grant-for-the-relay",
    });
    cleanup.push(() => client.close());
    await client.send({
      type: "hello",
      protocolVersion: 1,
      channel: "provider_auth",
      deviceId: DeviceId.parse(hello.deviceId ?? "phone"),
      grant: hello.grant ?? deviceGrant(),
      ...(hello.machineCode ? { machineCode: hello.machineCode } : {}),
    });
    const first: ServerMessage | Uint8Array = await client.receiveFrame();
    return { client, first };
  }
  return {
    root,
    account,
    backend,
    host,
    keys,
    open,
    deviceGrant,
    advance(milliseconds: number) {
      offset += milliseconds;
    },
  };
}

const refusal = (first: ServerMessage | Uint8Array) =>
  first instanceof Uint8Array || first.type !== "error" ? undefined : first.code;
async function closes(client: ClientChannel) {
  await expect(client.closed).resolves.toBeDefined();
}
/** An operate-scope request a paired read-only device is refused ("forbidden"). */
async function canOperate(client: ClientChannel) {
  await client.send({
    type: "provider.accounts.add",
    requestId: "add",
    provider: "codex",
    method: "api_key",
  });
  const answer = await client.receive();
  if (answer.type !== "provider.accounts.result" || answer.result.ok)
    throw new Error("Unexpected answer");
  return answer.result.error !== "forbidden";
}

it("a signed-in daemon registers with a machine grant and opens to a device on its account", async () => {
  const daemon = await signedInDaemon();
  expect(daemon.backend.grantRequests).toEqual([
    { kind: "machine", subject: hostId(daemon.keys.publicKey) },
  ]);
  expect(daemon.account.status()).toMatchObject({
    signedIn: true,
    account: { id: "user_a" },
    machineCode: { set: false },
  });
  expect((await stat(join(daemon.root, "ace-account.json"))).mode & 0o777).toBe(0o600);
  const { client, first } = await daemon.open();
  expect(first).toMatchObject({ type: "welcome", hostId: "host-1" });
  expect(await canOperate(client)).toBe(true);
});

it("grants for another account, another device, or past their expiry are refused", async () => {
  const daemon = await signedInDaemon();
  const attempts = [
    daemon.deviceGrant({ account: "user_b" }),
    daemon.deviceGrant({ subject: "laptop" }),
    daemon.deviceGrant({ iat: Date.now() - GRANT_LIFETIME_MS - 1_000 }),
  ];
  for (const grant of attempts) {
    const { client, first } = await daemon.open({ grant });
    expect(refusal(first)).toBe("unauthorized");
    await closes(client);
  }
});

it("a machine code is asked for once per device, and a wrong one is refused", async () => {
  const daemon = await signedInDaemon();
  await daemon.account.setMachineCode("2468");
  const asked = await daemon.open();
  expect(refusal(asked.first)).toBe("machine_code_required");
  await closes(asked.client);
  expect(refusal((await daemon.open({ machineCode: "1111" })).first)).toBe("machine_code_wrong");
  expect((await daemon.open({ machineCode: "2468" })).first).toMatchObject({ type: "welcome" });
  // Remembered for this device; another device on the account enters it too.
  expect((await daemon.open()).first).toMatchObject({ type: "welcome" });
  const tablet = daemon.deviceGrant({ subject: "tablet" });
  expect(refusal((await daemon.open({ deviceId: "tablet", grant: tablet })).first)).toBe(
    "machine_code_required",
  );
});

it("changing the machine code closes account channels and every device enters the new one", async () => {
  const daemon = await signedInDaemon();
  await daemon.account.setMachineCode("2468");
  const { client, first } = await daemon.open({ machineCode: "2468" });
  expect(first).toMatchObject({ type: "welcome" });
  await daemon.account.setMachineCode("1357");
  await closes(client);
  expect(refusal((await daemon.open()).first)).toBe("machine_code_required");
  expect((await daemon.open({ machineCode: "1357" })).first).toMatchObject({ type: "welcome" });
  // Clearing the code opens the machine to the account again.
  daemon.account.clearMachineCode();
  const other = daemon.deviceGrant({ subject: "tablet" });
  expect((await daemon.open({ deviceId: "tablet", grant: other })).first).toMatchObject({
    type: "welcome",
  });
});

it("five wrong machine codes lock code entry for fifteen minutes, even for the right code", async () => {
  const daemon = await signedInDaemon();
  await daemon.account.setMachineCode("2468");
  const answers: (string | undefined)[] = [];
  for (let attempt = 0; attempt < 5; attempt++)
    answers.push(refusal((await daemon.open({ machineCode: `000${attempt}` })).first));
  expect(answers).toEqual([
    ...Array.from({ length: 4 }, () => "machine_code_wrong"),
    "machine_code_locked",
  ]);
  expect(refusal((await daemon.open({ machineCode: "2468" })).first)).toBe("machine_code_locked");
  expect(daemon.account.status().machineCode.lockedUntil).toBeGreaterThan(Date.now());
  daemon.advance(CODE_LOCK_MS);
  expect((await daemon.open({ machineCode: "2468" })).first).toMatchObject({ type: "welcome" });
});

it("signing the machine out closes account channels and refuses new grants", async () => {
  const daemon = await signedInDaemon();
  const { client, first } = await daemon.open();
  expect(first).toMatchObject({ type: "welcome" });
  await daemon.account.signOut();
  await closes(client);
  expect(refusal((await daemon.open()).first)).toBe("unauthorized");
  await expect(stat(join(daemon.root, "ace-account.json"))).rejects.toThrow();
});

it("ace sign-in from this machine finishes in the browser, and signing out ends it at the backend", async () => {
  const backend = await startFakeAccountBackend(Date.now);
  cleanup.push(() => backend.close());
  const root = await mkdtemp(join(tmpdir(), "ace-account-login-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.sqlite"));
  cleanup.push(() => store.close());
  const options = {
    dataDir: root,
    codes: store.machineCodes,
    fetch: globalThis.fetch,
    now: Date.now,
    randomBytes,
    // Poll the sign-in quickly rather than every two seconds.
    delay: (run: () => void) => {
      const timer = setTimeout(run, 10);
      return () => clearTimeout(timer);
    },
  };
  const account = machineAccount({ ...options, defaultOrigin: backend.origin });
  cleanup.push(() => account.close());
  const started = await account.startLogin();
  expect(started).toMatchObject({
    signedIn: false,
    login: { url: expect.stringContaining("id=") },
  });
  backend.completeLogins();
  await expect.poll(() => account.status().signedIn).toBe(true);
  // Signed in on this machine: the desktop app never signs it out or moves it.
  expect(account.status()).toMatchObject({ account: { email: "a@example.com" }, source: "login" });
  expect(account.status().login).toBeUndefined();

  // The session survives a restart, and signing out ends the session sign-in created.
  const restarted = machineAccount(options);
  cleanup.push(() => restarted.close());
  await restarted.load();
  expect(restarted.status()).toMatchObject({ signedIn: true, origin: backend.origin });
  const stored = StoredSession.parse(
    JSON.parse(await readFile(join(root, "ace-account.json"), "utf8")),
  );
  expect(backend.live(stored.token)).toBe(true);
  await restarted.signOut();
  expect(backend.live(stored.token)).toBe(false);
  expect(restarted.status().signedIn).toBe(false);
});

it("a sign-in or sign-out decided on an older read never replaces the machine's own sign-in", async () => {
  const backend = await startFakeAccountBackend(Date.now);
  cleanup.push(() => backend.close());
  const root = await mkdtemp(join(tmpdir(), "ace-account-condition-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.sqlite"));
  cleanup.push(() => store.close());
  const account = machineAccount({
    dataDir: root,
    codes: store.machineCodes,
    fetch: globalThis.fetch,
    now: Date.now,
    randomBytes,
    delay: (run: () => void) => {
      const timer = setTimeout(run, 10);
      return () => clearTimeout(timer);
    },
    defaultOrigin: backend.origin,
  });
  cleanup.push(() => account.close());
  const read = account.status();
  expect(read.sessionId).toBeNull();

  // `ace login` finishes after the app read the machine as signed out.
  await account.startLogin();
  backend.completeLogins();
  await expect.poll(() => account.status().signedIn).toBe(true);
  const own = account.status();
  await expect(
    account.handover(backend.origin, backend.token, { session: read.sessionId ?? null }),
  ).rejects.toMatchObject({ status: 412 });
  await expect(account.signOut({ session: "stale" })).rejects.toMatchObject({ status: 412 });
  expect(account.status()).toMatchObject({ signedIn: true, source: "login" });
  expect(account.status().sessionId).toBe(own.sessionId);

  // A sign-in under way on this machine is the person's own too.
  await account.signOut();
  const signedOut = account.status();
  await account.startLogin();
  await expect(
    account.handover(backend.origin, backend.token, { session: signedOut.sessionId ?? null }),
  ).rejects.toMatchObject({ status: 412 });
  expect(account.status().login).toBeDefined();

  // Once nothing changed since the read, both apply.
  await account.signOut();
  const handed = await account.handover(backend.origin, backend.token, { session: null });
  expect(handed).toMatchObject({ signedIn: true, source: "handover" });
  expect(handed.sessionId).not.toBe(own.sessionId);
  expect(await account.signOut({ session: handed.sessionId ?? null })).toMatchObject({
    signedIn: false,
  });
});

it("the host signs the machine in and sets its code over the local API; others are refused", async () => {
  const backend = await startFakeAccountBackend(Date.now);
  cleanup.push(() => backend.close());
  let account: ReturnType<typeof machineAccount> | undefined;
  const f = await fixture({}, (store, home) => {
    account = machineAccount({
      dataDir: home,
      codes: store.machineCodes,
      fetch: globalThis.fetch,
      now: Date.now,
      randomBytes,
      delay: () => () => {},
    });
    return { machineAccount: account };
  });
  cleanup.push(async () => {
    await account?.close();
    await f.close();
  });
  const local = (path: string, method: string, body?: unknown, bearer = token) =>
    accessRequest(f.server.httpUrl, path, { method, token: bearer, ...(body ? { body } : {}) });
  await expect(
    local("/v1/ace-account", "PUT", { origin: backend.origin, token: "b".repeat(43) }),
  ).rejects.toThrow();
  expect(
    await local("/v1/ace-account", "PUT", { origin: backend.origin, token: backend.token }),
  ).toMatchObject({ signedIn: true, account: { id: "user_a" }, source: "handover" });
  await expect(local("/v1/machine-code", "PUT", { code: "12" })).rejects.toThrow();
  expect(await local("/v1/machine-code", "PUT", { code: "2468" })).toMatchObject({
    machineCode: { set: true },
  });
  // Remote status names the account; the code itself never appears.
  const status = JSON.stringify(await local("/v1/status", "GET"));
  expect(status).toContain('"account":{"id":"user_a"');
  expect(status).not.toContain("2468");
  expect(status).not.toContain(backend.token);
  await expect(local("/v1/machine-code", "DELETE", undefined, "0".repeat(64))).rejects.toThrow();
  expect(await local("/v1/machine-code", "DELETE")).toMatchObject({ machineCode: { set: false } });
  // Conditional on the session the caller read: 412 once it is another.
  const conditional = (method: string, header: Record<string, string>, body?: unknown) =>
    fetch(new URL("/v1/ace-account", f.server.httpUrl), {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...header },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const held = (await local("/v1/ace-account", "GET")) as { sessionId: string };
  const refused = await conditional(
    "PUT",
    { "if-none-match": "*" },
    { origin: backend.origin, token: backend.token },
  );
  expect(refused.status).toBe(412);
  expect((await conditional("DELETE", { "if-match": '"other"' })).status).toBe(412);
  const out = await conditional("DELETE", { "if-match": `"${held.sessionId}"` });
  expect(out.status).toBe(200);
  expect(await out.json()).toMatchObject({ signedIn: false, sessionId: null });
});

it("a session the backend no longer knows signs the machine out when it asks for a grant", async () => {
  const daemon = await signedInDaemon();
  daemon.backend.revoke(daemon.backend.token);
  await expect(daemon.account.machineGrant(daemon.host.hostId)).rejects.toThrow();
  expect(daemon.account.status().signedIn).toBe(false);
  expect(refusal((await daemon.open()).first)).toBe("unauthorized");
});
