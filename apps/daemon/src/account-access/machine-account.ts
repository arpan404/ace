import { aceAccountClient, AceAccountError } from "@ace/client/ace-account";
import { MachineAccountStatus, MachineCode, type MachineCodeRefusal } from "@ace/protocol";
import type { AceAccount } from "@ace/protocol/ace-account";
import { AccessError } from "../remote-auth.ts";
import { accountBackend } from "./backend.ts";
import { deviceGrantVerdict } from "./device-grant.ts";
import { grantKeyCache } from "./grant-keys.ts";
import { afterAttempt, codeStep } from "./machine-code-policy.ts";
import { hashMachineCode, machineCodeMatches, type MachineCodes } from "./machine-codes.ts";
import { readSession, writeSession, type StoredSession } from "./session-file.ts";

export type DeviceAdmission =
  | { admitted: true; account: string }
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

/**
 * A sign-in or sign-out that applies only while the daemon still holds the session the caller
 * read: its `sessionId`, or null for none.
 */
export type SessionCondition = { session: string | null };
const accountChanged = () =>
  new AccessError(412, "This machine's ace account changed. Read it again before changing it.");
const noop = () => {};

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
  log?: (error: Error) => void;
}) {
  const backend = accountBackend({ fetch: options.fetch });
  let session: StoredSession | undefined;
  /** In memory only: a restart gives the session a new id, so no decision outlives it. */
  let sessionId: string | null = null;
  let login: { url: string; expiresAt: number; stop(): void } | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  let codeChecks: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const keys = grantKeyCache({
    now: options.now,
    fetchKeys: () => {
      if (!session) return Promise.reject(new Error("Signed out"));
      return backend.keys(session.origin, AbortSignal.timeout(10_000));
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
  /** `before` runs in turn with every other write, so a condition it checks holds for this one. */
  const adopt = (next: StoredSession | undefined, before: () => void = noop) =>
    serial(async () => {
      before();
      await writeSession(options.dataDir, next ?? null);
      sessionId = next ? newId() : null;
      const changed = session?.account.id !== next?.account.id || session?.origin !== next?.origin;
      if (session?.origin !== next?.origin) keys.reset();
      session = next;
      if (changed) notify();
    });
  const stopLogin = () => {
    login?.stop();
    login = undefined;
  };
  const client = (origin: string) => aceAccountClient({ origin, fetch: options.fetch });

  return {
    async load(): Promise<void> {
      session = await readSession(options.dataDir);
      sessionId = session ? newId() : null;
    },
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
     * Take over a session another ace app on this machine holds, after the backend vouches for
     * it. With `condition`, only while the daemon still holds that session and no sign-in from
     * this machine is under way (412 otherwise), so a decision made on an older read never
     * replaces the person's own sign-in.
     */
    async handover(
      origin: string,
      token: string,
      condition?: SessionCondition,
    ): Promise<MachineAccountStatus> {
      let checked;
      try {
        checked = await client(origin).session(token, AbortSignal.timeout(10_000));
      } catch (error) {
        throw new AccessError(
          error instanceof AceAccountError && error.status === 401 ? 401 : 502,
          error instanceof AceAccountError ? error.message : "Couldn't reach your ace account.",
        );
      }
      await adopt({ origin, token, ...checked, source: "handover" }, () => {
        if (condition && (condition.session !== sessionId || login)) throw accountChanged();
        stopLogin();
      });
      return this.status();
    },
    /** Start signing in from this machine; the sign-in finishes when the person opens the URL. */
    async startLogin(origin = options.defaultOrigin): Promise<MachineAccountStatus> {
      if (!origin)
        throw new AccessError(400, "No ace account address. Set ACE_ACCOUNT_URL or pass --origin.");
      stopLogin();
      const controller = new AbortController();
      const account = client(origin);
      let started;
      try {
        started = await account.login(controller.signal);
      } catch {
        throw new AccessError(502, "Couldn't reach your ace account.");
      }
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
        cancelPoll = options.delay(() => {
          if (login !== current) return;
          if (options.now() >= current.expiresAt) {
            stopLogin();
            return;
          }
          account
            .poll(started, controller.signal)
            .then(async (result) => {
              if (login !== current) return;
              if (result.status === "pending") return poll();
              login = undefined;
              const { token, account: who, expiresAt } = result.session;
              await adopt({ origin, token, account: who, expiresAt, source: "login" });
            })
            .catch((error: unknown) => {
              if (login !== current) return;
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
      if (ending?.source === "login")
        await client(ending.origin)
          .logout(ending.token, AbortSignal.timeout(10_000))
          .catch(() => {});
      return this.status();
    },
    /** A fresh machine grant for ace's relay `/host`. Throws while signed out. */
    async machineGrant(hostId: string, signal?: AbortSignal): Promise<string> {
      const current = active();
      if (!current) throw new Error("Sign in to ace on this machine to use ace's relay.");
      const timeout = AbortSignal.timeout(10_000);
      try {
        const grant = await client(current.origin).grant(
          current.token,
          { kind: "machine", subject: hostId },
          signal ? AbortSignal.any([signal, timeout]) : timeout,
        );
        return grant.token;
      } catch (error) {
        // The backend no longer knows this session: the machine is signed out.
        if (error instanceof AceAccountError && error.status === 401 && session === current)
          await adopt(undefined);
        throw error;
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
      const verdict = deviceGrantVerdict(hello.grant, {
        keys: published,
        now: options.now(),
        account: active()?.account.id,
        deviceId: hello.deviceId,
      });
      if (!verdict.accepted) return unauthorized();
      const account = verdict.claims.account;
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
        if (step.kind === "admit") return { admitted: true, account };
        if (step.kind === "refuse")
          return { admitted: false, code: step.reason, message: refusals[step.reason] };
        if (!code) return { admitted: true, account };
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
        return { admitted: true, account };
      });
      codeChecks = run.catch(() => {});
      return run;
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
      stopLogin();
      listeners.clear();
      await writes;
    },
  };
}
export type MachineAccount = ReturnType<typeof machineAccount>;
