import { aceAccountClient, AceAccountError } from "@ace/client/ace-account";
import { MachineAccountStatus, MachineCode, type MachineCodeRefusal } from "@ace/protocol";
import type { AceAccount, AceAccountGrant } from "@ace/protocol/ace-account";
import { AccessError } from "../remote-auth.ts";
import { accountBackend } from "./backend.ts";
import { deviceGrantVerdict, provenStanding } from "./device-grant.ts";
import { grantKeyCache } from "./grant-keys.ts";
import { MARKET_GRANT_ISSUER, encodeBase64url, type GrantKeySet } from "@ace/account-grant";
import { verifiedSignInFresh } from "../marketplace/fresh-sign-in.ts";
import { shippedGrantKeys } from "@ace/account-grant/keys";
import { afterAttempt, codeStep } from "./machine-code-policy.ts";
import { hashMachineCode, machineCodeMatches, type MachineCodes } from "./machine-codes.ts";
import {
  readPending,
  readSession,
  writePending,
  writeSession,
  type PendingCredential,
  type StoredSession,
} from "./session-file.ts";
import { machineCredentialProof } from "@ace/account-grant/machine-proof";
import { hostId as hostIdOf, type KeyPair } from "@ace/secure-channel";

export type DeviceAdmission =
  /**
   * `expiresAt`: when the grant runs out (its `exp`); the socket must refresh before then.
   * Admission gives admin, never the person's standing, which a socket proves on its own
   * (`proveStanding`, ADR 0190).
   */
  | { admitted: true; account: string; expiresAt: number }
  | { admitted: false; code: "unauthorized" | MachineCodeRefusal; message: string };

const refusals: Record<MachineCodeRefusal, string> = {
  machine_code_required: "Enter this machine's code.",
  machine_code_wrong: "That machine code is wrong.",
  machine_code_locked: "Too many wrong machine codes. Try again in 15 minutes.",
};
const unauthorized = (message = "Valid hello required"): DeviceAdmission => ({
  admitted: false,
  code: "unauthorized",
  message,
});
const loginPollMs = 2_000;
/** A sign-in that couldn't reach the backend, or was given up as the account closed. */
const unreachable = () => new AccessError(502, "Couldn't reach your ace account.");
/**
 * How often the daemon reads its session back from the backend. Each read renews it there
 * (ADR 0100), and the answer carries the new expiry, so a machine left running stays signed in.
 */
export const SESSION_RENEW_MS = 60 * 60_000;

/**
 * A sign-in or sign-out that applies only while the daemon still holds the session the caller
 * read: its `sessionId`, or null for none.
 */
export type SessionCondition = { session: string | null };
const accountChanged = () =>
  new AccessError(412, "This machine's ace account changed. Read it again before changing it.");
const noop = () => {};
/** What the daemon keeps for a machine credential the backend issued it (ADR 0190). */
const asCredential = (
  origin: string,
  credential: AceAccountGrant,
  source: StoredSession["source"],
): StoredSession => ({
  origin,
  token: credential.token,
  account: credential.account,
  expiresAt: credential.expiresAt,
  source,
  kind: "machine",
});

/**
 * This daemon's ace account (ADR 0111): its one session, sign-in from this machine, machine
 * grants for ace's relay, device grant admission and the optional machine code. Fetch, clock,
 * randomness and timers are injected.
 */
export function machineAccount(options: {
  dataDir: string;
  codes: MachineCodes;
  fetch: typeof fetch;
  now: () => number;
  randomBytes: (size: number) => Buffer;
  delay: (run: () => void, milliseconds: number) => () => void;
  /** Where `ace login` signs in when it names no origin (ACE_ACCOUNT_URL). */
  defaultOrigin?: string | undefined;
  /**
   * This machine's relay host key (`relayKeysFor`): its machine credential is bound to the host
   * id it names, and asked for with proof of it (ADR 0190).
   */
  relayKeys: () => Promise<KeyPair>;
  /**
   * The grant keys whose standing grants give an account device the person's standing (ADR
   * 0190); `shippedGrantKeys` unless a test injects its own. Never read from the environment.
   */
  personKeys?: GrantKeySet | undefined;
  /** The `iss` market grants from this backend name; `cloud.acehq.dev` unless a test's. */
  marketIssuer?: string | undefined;
  log?: (error: Error) => void;
}) {
  const backend = accountBackend({ fetch: options.fetch });
  let session: StoredSession | undefined;
  /** In memory only: a restart gives the session a new id, so no decision outlives it. */
  let sessionId: string | null = null;
  let login: { url: string; expiresAt: number; stop(): void } | undefined;
  /** The backend answered that it has no machine credentials (an older one): sessions stay. */
  let noCredentials = false;
  // Never keys from the session's origin, which the host token sets, or from ACE_ACCOUNT_URL.
  const personKeys = options.personKeys ?? shippedGrantKeys;
  let stopRenewing: () => void = noop;
  let closed = false;
  // Closing gives up every request still out to the backend: shutdown never waits on it.
  const closing = new AbortController();
  /** A request's signal: its own time limit, ended early when the account closes. */
  const request = () => AbortSignal.any([closing.signal, AbortSignal.timeout(10_000)]);
  let writes: Promise<unknown> = Promise.resolve();
  let codeChecks: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const keys = grantKeyCache({
    now: options.now,
    fetchKeys: () => {
      if (!session) return Promise.reject(new Error("Signed out"));
      return backend.keys(session.origin, request());
    },
  });
  const active = () => (session && session.expiresAt > options.now() ? session : undefined);
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        options.log?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = writes.then(run);
    writes = next.catch(() => {});
    return next;
  };
  const newId = () => options.randomBytes(16).toString("base64url");
  const client = (origin: string) => aceAccountClient({ origin, fetch: options.fetch });
  /** Gives a machine credential this daemon no longer keeps back to the backend, best effort. */
  const giveBack = (replaced: StoredSession | undefined) => {
    if (replaced?.kind !== "machine") return;
    void client(replaced.origin)
      .logout(replaced.token, request())
      .catch(() => {});
  };
  /**
   * `before` runs in turn with every other write, so a condition it checks holds for this one.
   * A machine credential it replaces is given back.
   */
  const adopt = (next: StoredSession | undefined, before: () => void = noop) =>
    serial(async () => {
      before();
      await writeSession(options.dataDir, next ?? null);
      sessionId = next ? newId() : null;
      const changed = session?.account.id !== next?.account.id || session?.origin !== next?.origin;
      if (session?.origin !== next?.origin) keys.reset();
      const replaced = session;
      session = next;
      if (replaced?.token !== next?.token) giveBack(replaced);
      if (changed) notify();
    });
  const stopLogin = () => {
    login?.stop();
    login = undefined;
  };
  /** This machine's host id on ace's relay, which its credential and person grants name. */
  let hostIdKnown: string | undefined;
  const ownHostId = async () => (hostIdKnown ??= hostIdOf((await options.relayKeys()).publicKey));
  /** A credential this daemon chooses itself, so it can use it whatever became of the answer. */
  const newCredential = () => options.randomBytes(32).toString("base64url");
  /**
   * Ask the backend to issue `credential` as this machine's (ADR 0190), for an ace session the
   * daemon holds (`token`) or an enrollment ticket the app got, proving the relay host key the
   * host id names. Undefined from a backend that has no machine credentials (an older one).
   * `sole`: this daemon was the session's only holder, so the backend retires its token.
   * `onDisk`: the session was written to this machine's disk, so it never speaks for the person.
   * Idempotent: asked again with the same credential after a lost answer, it answers the same.
   */
  async function exchange(
    origin: string,
    from: { token: string } | { ticket: string },
    credential: string,
    held: { sole: boolean; onDisk: boolean },
    signal: AbortSignal,
  ): Promise<AceAccountGrant | undefined> {
    const published = await backend.keys(origin, signal);
    if (published.exchangeKey === undefined) {
      noCredentials = true;
      return undefined;
    }
    const hostKeys = await options.relayKeys();
    const hostId = await ownHostId();
    const proof = machineCredentialProof({
      hostPrivateKey: hostKeys.privateKey,
      exchangeKey: published.exchangeKey,
      hostId,
      credential,
    });
    try {
      const issued = await client(origin).machineCredential(
        "token" in from ? from.token : undefined,
        {
          hostId,
          hostKey: encodeBase64url(hostKeys.publicKey),
          credential,
          proof,
          ...("ticket" in from ? { ticket: from.ticket } : {}),
          ...(held.sole ? { sole: true } : {}),
          ...(held.onDisk ? { exposed: true } : {}),
        },
        signal,
      );
      noCredentials = false;
      return issued;
    } catch (error) {
      if (!(error instanceof AceAccountError) || error.status !== 404) throw error;
      noCredentials = true;
      return undefined;
    }
  }
  /**
   * Exchange with a credential written to disk first (ADR 0190): if the answer is lost or the
   * daemon stops, `load` finds it and tries it. Undefined when the backend has none; throws when
   * it refused or couldn't be reached, after checking the credential didn't work anyway.
   */
  async function exchangeKept(
    origin: string,
    from: { token: string } | { ticket: string },
    held: { sole: boolean; onDisk: boolean; source: StoredSession["source"] },
  ): Promise<AceAccountGrant | undefined> {
    const credential = newCredential();
    await writePending(options.dataDir, { origin, credential, source: held.source });
    try {
      const issued = await exchange(origin, from, credential, held, request());
      if (!issued) await writePending(options.dataDir, null);
      return issued;
    } catch (error) {
      const recovered = await client(origin)
        .session(credential, request())
        .catch(() => undefined);
      if (recovered) return { token: credential, ...recovered };
      throw error;
    }
  }
  /** The backend no longer knows `current`: the machine is signed out, unless it changed since. */
  const forget = (current: StoredSession) =>
    serial(async () => {
      if (session !== current || current.expiresAt <= options.now()) return;
      await writeSession(options.dataDir, null);
      session = undefined;
      sessionId = null;
      notify();
    });

  /**
   * A session file from before machine credentials (ADR 0190) holds an ace session. Exchanged
   * once for this machine's credential, the file then holds only that. Until it is, the daemon
   * keeps working with it (its grants have a machine's standing at the backend) and tries again
   * on the next renewal round; a session the backend no longer knows signs the machine out.
   * False when the backend has no machine credentials: the session is renewed as before.
   */
  async function migrate(current: StoredSession): Promise<boolean> {
    let credential;
    try {
      credential = await exchangeKept(
        current.origin,
        { token: current.token },
        { sole: current.source === "login", onDisk: true, source: current.source },
      );
    } catch (error) {
      if (closed) return true;
      if (error instanceof AceAccountError && error.status === 401) await forget(current);
      return true;
    }
    if (!credential) return false;
    await settle(current, asCredential(current.origin, credential, current.source));
    return true;
  }
  /**
   * Keep `next`, a credential the backend issued for the sign-in `current` was, unless the
   * daemon signed in afresh meanwhile, when it goes back. Either way the pending file goes.
   */
  const settle = (current: StoredSession | undefined, next: StoredSession) =>
    serial(async () => {
      if (session !== current) giveBack(next);
      else {
        // Written even as the account closes: the session's token may be retired already.
        await writeSession(options.dataDir, next);
        // The same sign-in, now as a credential: decisions read before this still apply.
        session = next;
        notify();
      }
      await writePending(options.dataDir, null);
    });
  /**
   * A credential asked for before the daemon stopped or lost the answer (ADR 0190): kept if the
   * backend issued it, dropped if it didn't. True when it is now the machine's sign-in.
   */
  async function recover(pending: PendingCredential): Promise<boolean> {
    let checked;
    try {
      checked = await client(pending.origin).session(pending.credential, request());
    } catch (error) {
      if (error instanceof AceAccountError && error.status === 401)
        await writePending(options.dataDir, null);
      return false;
    }
    await settle(session, {
      origin: pending.origin,
      token: pending.credential,
      ...checked,
      source: pending.source,
      kind: "machine",
    });
    return true;
  }

  async function marketGrant(signal?: AbortSignal): Promise<string | undefined> {
    if (!active()) return undefined;
    try {
      return await obtainGrant(await ownHostId(), "market-publish", signal);
    } catch (error) {
      // The backend ended the session: this machine is signed out now.
      if (error instanceof AceAccountError && error.status === 401) return undefined;
      throw error;
    }
  }

  async function obtainGrant(
    hostId: string,
    purpose: "spade-cloud" | "market-publish" | undefined,
    signal?: AbortSignal,
    kind: "machine" | "device" = "machine",
  ): Promise<string> {
    const current = active();
    if (!current) throw new Error("Sign in to ace on this machine to use ace's relay.");
    const limit = request();
    try {
      const grant = await client(current.origin).grant(
        current.token,
        { kind, subject: hostId, ...(purpose ? { purpose } : {}) },
        signal ? AbortSignal.any([signal, limit]) : limit,
      );
      return grant.token;
    } catch (error) {
      // The backend no longer knows this session: the machine is signed out.
      if (error instanceof AceAccountError && error.status === 401 && session === current)
        await adopt(undefined);
      throw error;
    }
  }

  /**
   * Reads the stored session back from the backend, which renews it, and keeps the expiry and
   * account details it answers with. A session that lapsed here but that the backend still holds
   * (renewed elsewhere, or a clock that slept) comes back. One the backend no longer knows signs
   * the machine out while it still looked live; a lapsed one is left for the app to replace.
   * Network failures keep what is stored and try again on the next round.
   */
  async function renew(): Promise<void> {
    const pending = await readPending(options.dataDir);
    if (pending && (await recover(pending))) return;
    const current = session;
    if (!current) return;
    // Exchanging the session reads it at the backend too, which renews it.
    if (current.kind !== "machine" && (await migrate(current))) return;
    let checked;
    try {
      checked = await client(current.origin).session(current.token, request());
    } catch (error) {
      if (closed) return;
      if (error instanceof AceAccountError && error.status === 401 && session === current)
        await forget(current);
      return;
    }
    if (checked.account.id !== current.account.id) return;
    await serial(async () => {
      // An answer that arrives as the account closes is dropped; the next start renews again.
      if (closed || session !== current) return;
      const wasActive = current.expiresAt > options.now();
      const next = { ...current, account: checked.account, expiresAt: checked.expiresAt };
      await writeSession(options.dataDir, next);
      // The same session, renewed: conditional changes read before this still apply.
      session = next;
      if (!wasActive && next.expiresAt > options.now()) notify();
    });
  }
  const scheduleRenew = () => {
    if (closed) return;
    stopRenewing = options.delay(() => {
      void renew()
        .catch((error: unknown) =>
          options.log?.(error instanceof Error ? error : new Error(String(error))),
        )
        .finally(scheduleRenew);
    }, SESSION_RENEW_MS);
  };

  /** The grant's verdict under `published`, then the machine code, one check at a time. */
  async function admitWith(
    published: GrantKeySet,
    hello: {
      grant: string;
      deviceId: string;
      machineCode?: string | undefined;
    },
  ): Promise<DeviceAdmission> {
    const verdict = deviceGrantVerdict(hello.grant, {
      keys: published,
      now: options.now(),
      account: active()?.account.id,
      deviceId: hello.deviceId,
      host: await ownHostId(),
    });
    if (!verdict.accepted) return unauthorized();
    const account = verdict.claims.account;
    const expiresAt = verdict.claims.exp;
    // One code check at a time, so concurrent wrong codes all count toward the lock.
    const run = codeChecks.then(async (): Promise<DeviceAdmission> => {
      const code = options.codes.current();
      const step = codeStep({
        required: code !== undefined,
        passed: code === undefined || options.codes.passed(hello.deviceId, account, code.version),
        offered: hello.machineCode,
        lock: options.codes.lock(),
        now: options.now(),
      });
      if (step.kind === "admit") return { admitted: true, account, expiresAt };
      if (step.kind === "refuse")
        return { admitted: false, code: step.reason, message: refusals[step.reason] };
      if (!code) return { admitted: true, account, expiresAt };
      const correct = await machineCodeMatches(step.code, code.hash);
      // The code changed while it was checked: the device enters the new one.
      if (options.codes.current()?.version !== code.version)
        return {
          admitted: false,
          code: "machine_code_required",
          message: refusals.machine_code_required,
        };
      const next = afterAttempt(options.codes.lock(), correct, options.now());
      options.codes.saveLock(next.lock);
      if (next.step.kind === "refuse")
        return { admitted: false, code: next.step.reason, message: refusals[next.step.reason] };
      options.codes.rememberPass(hello.deviceId, account, code.version, options.now());
      return { admitted: true, account, expiresAt };
    });
    codeChecks = run.catch(() => {});
    return run;
  }
  return {
    /** Reads the stored session, then keeps it renewed while the daemon runs. */
    async load(): Promise<void> {
      session = await readSession(options.dataDir);
      // A local file, read once: the host id an app's enrollment ticket names (ADR 0190).
      await ownHostId().catch(() => undefined);
      sessionId = session ? newId() : null;
      stopRenewing();
      void renew().catch((error: unknown) =>
        options.log?.(error instanceof Error ? error : new Error(String(error))),
      );
      scheduleRenew();
    },
    /** Renew the session now (`load` keeps doing it on a timer). */
    renew,
    status(): MachineAccountStatus {
      const current = active();
      const code = options.codes.current();
      const lock = options.codes.lock();
      return MachineAccountStatus.parse({
        signedIn: current !== undefined,
        ...(session
          ? {
              origin: session.origin,
              account: session.account,
              expiresAt: session.expiresAt,
              source: session.source,
            }
          : {}),
        sessionId,
        ...(hostIdKnown ? { relayHostId: hostIdKnown } : {}),
        // A session from before machine credentials that couldn't be exchanged yet.
        ...(session && session.kind !== "machine" && !noCredentials
          ? { signInAgain: true as const }
          : {}),
        ...(login && login.expiresAt > options.now()
          ? { login: { url: login.url, expiresAt: login.expiresAt } }
          : {}),
        machineCode: {
          set: code !== undefined,
          ...(lock.lockedUntil !== null && lock.lockedUntil > options.now()
            ? { lockedUntil: lock.lockedUntil }
            : {}),
        },
      });
    },
    /** The signed-in account id, while the session lasts. */
    account(): AceAccount | undefined {
      return active()?.account;
    },
    /**
     * Take over the ace sign-in of another ace app on this machine: the daemon exchanges the
     * app's session for this machine's credential (ADR 0190) and keeps only that; the session
     * itself stays in memory for the exchange and is never written. A backend without machine
     * credentials vouches for the session, which is kept as before. With `condition`, only while
     * the daemon still holds that session and no sign-in from this machine is under way (412
     * otherwise), so a decision made on an older read never replaces the person's own sign-in.
     */
    async handover(
      origin: string,
      from: { ticket: string } | { token: string },
      condition?: SessionCondition,
    ): Promise<MachineAccountStatus> {
      let taken: StoredSession;
      try {
        const credential = await exchangeKept(origin, from, {
          sole: false,
          onDisk: false,
          source: "handover",
        });
        if (credential) taken = asCredential(origin, credential, "handover");
        // A backend without machine credentials: a session is kept as before; a ticket is
        // something only a backend with them gives out.
        else if ("token" in from)
          taken = {
            origin,
            token: from.token,
            ...(await client(origin).session(from.token, request())),
            source: "handover",
          };
        else throw new AccessError(502, "Couldn't reach your ace account.");
      } catch (error) {
        if (error instanceof AccessError) throw error;
        throw new AccessError(
          error instanceof AceAccountError && error.status === 401 ? 401 : 502,
          error instanceof AceAccountError ? error.message : "Couldn't reach your ace account.",
        );
      }
      try {
        await adopt(taken, () => {
          // Closed while the backend answered: nothing is taken up or written.
          if (closed) throw unreachable();
          if (condition && (condition.session !== sessionId || login)) throw accountChanged();
          stopLogin();
        });
      } catch (error) {
        // Not taken up: the credential made for it goes back.
        giveBack(taken);
        await writePending(options.dataDir, null);
        throw error;
      }
      await writePending(options.dataDir, null);
      return this.status();
    },
    /** Start signing in from this machine; the sign-in finishes when the person opens the URL. */
    async startLogin(origin = options.defaultOrigin): Promise<MachineAccountStatus> {
      if (!origin)
        throw new AccessError(400, "No ace account address. Set ACE_ACCOUNT_URL or pass --origin.");
      stopLogin();
      // Closing the account gives the sign-in up too, from its first request on.
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, closing.signal]);
      const account = client(origin);
      if (closed) throw unreachable();
      let started;
      try {
        // A daemon's sign-in: its session never speaks for the person (ADR 0190).
        started = await account.login(signal, { holder: "machine" });
      } catch {
        throw unreachable();
      }
      // Closed while asking: nothing is installed, polled or written for it.
      if (closed) throw unreachable();
      let cancelPoll: () => void = noop;
      const current = {
        url: started.loginUrl,
        expiresAt: started.expiresAt,
        stop() {
          cancelPoll();
          controller.abort();
        },
      };
      login = current;
      const poll = () => {
        if (closed || login !== current) return;
        cancelPoll = options.delay(() => {
          if (closed || login !== current) return;
          if (options.now() >= current.expiresAt) {
            stopLogin();
            return;
          }
          account
            .poll(started, signal)
            .then(async (result) => {
              if (closed || login !== current) return;
              if (result.status === "pending") return poll();
              login = undefined;
              const { token, account: who, expiresAt } = result.session;
              // This daemon is the session's only holder: it keeps this machine's credential
              // instead, and the session's token is retired (ADR 0190). If that fails, the
              // sign-in ends without writing the session; the person signs in again.
              let credential;
              try {
                credential = await exchangeKept(
                  origin,
                  { token },
                  { sole: true, onDisk: false, source: "login" },
                );
              } catch {
                await account.logout(token, request()).catch(() => {});
                await writePending(options.dataDir, null);
                return;
              }
              await adopt(
                credential
                  ? asCredential(origin, credential, "login")
                  : { origin, token, account: who, expiresAt, source: "login" },
              );
              await writePending(options.dataDir, null);
            })
            .catch((error: unknown) => {
              if (closed || login !== current) return;
              // An expired or cancelled sign-in ends; a network blip keeps polling.
              if (error instanceof AceAccountError && [401, 404, 410].includes(error.status))
                stopLogin();
              else poll();
            });
        }, loginPollMs);
      };
      poll();
      return this.status();
    },
    /**
     * Sign out. With `condition`, only while the daemon still holds that session (412 otherwise);
     * a sign-in from this machine under way is then left to finish.
     */
    async signOut(condition?: SessionCondition): Promise<MachineAccountStatus> {
      const ended: { session?: StoredSession | undefined } = {};
      await adopt(undefined, () => {
        if (condition && condition.session !== sessionId) throw accountChanged();
        if (!condition) stopLogin();
        ended.session = session;
      });
      const ending = ended.session;
      // A machine credential went back as it was dropped; a session `ace login` made ends too.
      if (ending?.kind !== "machine" && ending?.source === "login")
        await client(ending.origin)
          .logout(ending.token, request())
          .catch(() => {});
      return this.status();
    },
    /** A fresh machine grant for ace's relay `/host`. */
    machineGrant(hostId: string, signal?: AbortSignal): Promise<string> {
      return obtainGrant(hostId, undefined, signal);
    },
    /**
     * A device grant naming `deviceId`, this machine's paired device on another machine of the
     * same account, so it may open a stream to that machine through ace's relay (ADR 0182).
     */
    deviceGrant(deviceId: string, signal?: AbortSignal): Promise<string> {
      return obtainGrant(deviceId, undefined, signal, "device");
    },
    /** A credential restricted to Spade Cloud, rejected by the relay. */
    cloudGrant(hostId: string, signal?: AbortSignal): Promise<string> {
      return obtainGrant(hostId, "spade-cloud", signal);
    },
    /**
     * A market grant for one publishing request (ADR 0174 §2), or undefined when no ace account
     * is signed in here: a machine's grant for this machine's relay host id, which the market
     * takes for publishing but never for a sensitive action (ADR 0190). The caller holds it for
     * that request only.
     */
    marketGrant,
    /**
     * Whether this machine's ace account signed in in a browser within ten minutes (ADR 0174 §2,
     * ADR 0190), from a market grant taken for the check and verified against the keys this build
     * pins, for this account and this machine's relay host id. False when signed out or
     * unreachable, and for a backend whose key isn't pinned.
     */
    async freshSignIn(): Promise<boolean> {
      const account = active()?.account.id;
      if (account === undefined) return false;
      try {
        const grant = await marketGrant();
        return (
          grant !== undefined &&
          verifiedSignInFresh(grant, {
            keys: personKeys,
            issuer: options.marketIssuer ?? MARKET_GRANT_ISSUER,
            now: options.now(),
            account,
            subject: await ownHostId(),
          })
        );
      } catch {
        return false;
      }
    },
    /** Admit a hello's device grant, asking for the machine code when one is set. */
    async admitDevice(hello: {
      grant: string;
      deviceId: string;
      machineCode?: string | undefined;
    }): Promise<DeviceAdmission> {
      const current = active();
      if (!current) return unauthorized();
      let published;
      try {
        published = await keys.forGrant(hello.grant);
      } catch {
        return unauthorized("Couldn't check this device's ace account. Try again.");
      }
      return admitWith(published, hello);
    },
    /**
     * `admitDevice` that never waits on the network (an NK first message, ADR 0155): a grant
     * whose key isn't cached is refused now, and the key is fetched for the next attempt.
     */
    async admitDeviceCached(hello: { grant: string; deviceId: string }): Promise<DeviceAdmission> {
      if (!active()) return unauthorized();
      const published = keys.cached(hello.grant);
      return published ? admitWith(published, hello) : unauthorized();
    },
    /**
     * The person's standing an admitted account device proves on one socket (ADR 0190): a
     * person's grant for this host, signed by a key this build pins, and its device key's
     * signature over this socket's nonce. Undefined unless all of it holds; `until` otherwise.
     */
    async proveStanding(input: {
      grant: string;
      proof: string;
      nonce: string;
      deviceId: string;
      account: string;
    }): Promise<{ until: number } | undefined> {
      if (active()?.account.id !== input.account) return undefined;
      return provenStanding({
        ...input,
        keys: personKeys,
        now: options.now(),
        host: await ownHostId(),
      });
    },
    /** Whether an admitted account device keeps access: same account, current code passed. */
    stillAdmitted(deviceId: string, account: string): boolean {
      if (active()?.account.id !== account) return false;
      const code = options.codes.current();
      return code === undefined || options.codes.passed(deviceId, account, code.version);
    },
    /**
     * Set or replace the code. `keep` is an account device setting it: it knows the new code, so
     * it keeps its access while every other device enters the new one.
     */
    async setMachineCode(
      code: string,
      keep?: { deviceId: string; account: string },
    ): Promise<MachineAccountStatus> {
      const parsed = MachineCode.safeParse(code);
      if (!parsed.success) throw new AccessError(400, "A machine code has 4 to 128 characters.");
      options.codes.replace(await hashMachineCode(parsed.data, options.randomBytes(16)));
      const current = options.codes.current();
      if (keep && current && active()?.account.id === keep.account)
        options.codes.rememberPass(keep.deviceId, keep.account, current.version, options.now());
      notify();
      return this.status();
    },
    clearMachineCode(): MachineAccountStatus {
      options.codes.replace(null);
      notify();
      return this.status();
    },
    /** Called when the account or the machine code changes; open account channels recheck. */
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close(): Promise<void> {
      closed = true;
      closing.abort();
      stopRenewing();
      stopLogin();
      listeners.clear();
      await writes;
    },
  };
}
export type MachineAccount = ReturnType<typeof machineAccount>;
