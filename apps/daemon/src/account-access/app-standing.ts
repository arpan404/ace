import {
  APP_STANDING_MAX_SOCKETS,
  AppSocketTag,
  AppStandingChallengeRequest,
  AppStandingStatement,
  type AppSocket as TaggedSocket,
  type AppStandingChallenge,
} from "@ace/protocol";
import {
  enrollAction,
  possessionMac,
  socketsTarget,
  tagFresh,
  TAG_FRESH_MS,
} from "@ace/account-grant/app-channel";
import { verifyStatement, type PersonStatement } from "@ace/account-grant/person-statement";

/*
 * The person's standing on the desktop app's own sockets (ADR 0190, amendment 1). The app's main
 * process tags each WebSocket upgrade from the app's own page with a fresh secret header no page
 * sees. It fetches a challenge itself: the daemon proves it holds the relay key main pinned, and
 * names the live socket behind each of main's tags by that connection's own nonce. Main then
 * proves for those sockets with a person's statement its device key signed. A page never hands
 * over a challenge or names a socket, a tag names one socket ever, and a stale tag names none.
 * Enrolling a key takes a grant ace's account backend signed with a sign-in from the last ten
 * minutes, naming this daemon, the key and the challenge, beside a socket that proved the
 * owner's grant; never another statement. Signing out revokes the key and the standing it gave.
 */

/** One tagged socket, as the server lets this module touch it. */
export interface AppSocket {
  /** This connection's own nonce (its welcome's `standingNonce`). */
  connection: string;
  /** Gives the socket the person's standing from `key`, proven under `generation`. */
  grantApp(key: string, generation: number): boolean;
  /** The owner generation, when the socket proved the owner's own grant (not a statement). */
  grantProven(): number | undefined;
  /** Ends standing this socket took from `key`. */
  dropApp(key: string): void;
}

/** A sign-in the account backend vouched for: who, and when. */
export interface FreshSignIn {
  account: string;
  authAt: number;
  action: string | undefined;
}

/** What this reads of the machine's account. */
export interface AppStandingMachine {
  relayHostId(): string | undefined;
  /** The X25519 secret between the relay key and `ephemeral`. */
  relayShared(ephemeral: Uint8Array): Promise<Uint8Array | undefined>;
  /** A grant the account backend signed, read with the keys this build pins; else undefined. */
  signInGrant(token: string): FreshSignIn | undefined;
  ownerAccount(): string | undefined;
  ownerOrg(): string | undefined;
  ownerGeneration(): number;
  appKeys(): readonly string[];
  addAppKey(key: string, generation: number): Promise<boolean>;
  removeAppKey(key: string): Promise<void>;
}

/** How long a challenge waits to be used, and how many may wait at once. */
const CHALLENGE_MS = 60_000;
const MAX_CHALLENGES = 64;
/** How recent the sign-in behind an enrollment must be. */
export const ENROLL_SIGN_IN_MS = 10 * 60_000;

export function appStandingDesk(deps: {
  now(): number;
  /** A fresh single-use nonce. */
  nonce(): string;
  machine(): AppStandingMachine | undefined;
}) {
  const sockets = new Map<string, AppSocket>();
  /**
   * Every tag a socket came with, until it can't be fresh again: a second socket with one gets
   * nothing, and a tag older than that is refused for being stale, so none is ever forgotten
   * while it could still be used.
   */
  const seen = new Map<string, number>();
  const challenges = new Map<string, number>();
  const take = (nonce: string): boolean => {
    const until = challenges.get(nonce);
    challenges.delete(nonce);
    return until !== undefined && until > deps.now();
  };
  /** The statement in `body`, checked for `purpose` against this machine and its owner now. */
  const checked = async (
    body: unknown,
    purpose: PersonStatement["purpose"],
  ): Promise<
    | { statement: PersonStatement; key: string; sockets: TaggedSocket[]; signIn?: string }
    | undefined
  > => {
    const machine = deps.machine();
    const parsed = AppStandingStatement.safeParse(body);
    if (!machine || !parsed.success || machine.ownerOrg() !== undefined) return undefined;
    const owner = machine.ownerAccount();
    const host = machine.relayHostId();
    const statement = await verifyStatement({
      text: parsed.data.statement,
      proof: parsed.data.proof,
      publicKey: parsed.data.key,
      now: deps.now(),
    });
    if (!statement || !take(statement.nonce)) return undefined;
    if (statement.purpose !== purpose || statement.action !== "socket") return undefined;
    if (owner === undefined || statement.account !== owner || statement.audience !== host)
      return undefined;
    if (statement.target !== socketsTarget(parsed.data.sockets)) return undefined;
    return {
      statement,
      key: parsed.data.key,
      sockets: parsed.data.sockets,
      ...(parsed.data.signIn ? { signIn: parsed.data.signIn } : {}),
    };
  };
  /** The live socket `named` is, only while its tag still names that very connection. */
  const live = (named: TaggedSocket): AppSocket | undefined => {
    const socket = sockets.get(named.tag);
    return socket?.connection === named.connection ? socket : undefined;
  };
  return {
    /**
     * Keeps `socket` under `tag` until the returned detach runs (its close); undefined for a
     * stale tag or one a socket already came with, which never takes a live socket's place.
     */
    attach(tag: string, socket: AppSocket): (() => void) | undefined {
      const now = deps.now();
      for (const [old, at] of seen) if (now - at > 2 * TAG_FRESH_MS) seen.delete(old);
      if (!AppSocketTag.safeParse(tag).success || !tagFresh(tag, now) || seen.has(tag))
        return undefined;
      seen.set(tag, now);
      sockets.set(tag, socket);
      return () => {
        if (sockets.get(tag) === socket) sockets.delete(tag);
      };
    },
    /**
     * A single-use challenge for main's ephemeral key and tags: the live sockets behind them and
     * the possession proof. Undefined while the machine has no relay key.
     */
    async challenge(body: unknown): Promise<AppStandingChallenge | undefined> {
      const machine = deps.machine();
      const host = machine?.relayHostId();
      const asked = AppStandingChallengeRequest.safeParse(body);
      if (!machine || host === undefined || !asked.success) return undefined;
      const shared = await machine.relayShared(
        new Uint8Array(Buffer.from(asked.data.ephemeral, "base64url")),
      );
      if (!shared) return undefined;
      const now = deps.now();
      for (const [nonce, until] of challenges) if (until <= now) challenges.delete(nonce);
      while (challenges.size >= MAX_CHALLENGES) {
        const oldest = challenges.keys().next().value;
        if (oldest === undefined) break;
        challenges.delete(oldest);
      }
      const nonce = deps.nonce();
      challenges.set(nonce, now + CHALLENGE_MS);
      const found = asked.data.tags.flatMap((tag) => {
        const socket = sockets.get(tag);
        return socket ? [{ tag, connection: socket.connection }] : [];
      });
      const reply = { nonce, host, owner: machine.ownerAccount() ?? null, sockets: found };
      return { ...reply, possession: possessionMac(shared, reply) };
    },
    /** A `standing` statement from a key the owner enrolled: its sockets become theirs. */
    async prove(body: unknown): Promise<number> {
      const machine = deps.machine();
      const generation = machine?.ownerGeneration();
      const ok = await checked(body, "standing");
      if (!machine || generation === undefined || !ok || !machine.appKeys().includes(ok.key))
        return 0;
      let proven = 0;
      for (const named of ok.sockets.slice(0, APP_STANDING_MAX_SOCKETS))
        if (live(named)?.grantApp(ok.key, generation)) proven++;
      return proven;
    },
    /**
     * An `enroll` statement: the key is the owner's from now on, if the account backend vouches
     * for a sign-in from the last ten minutes that names this enrollment, and one of its sockets
     * proved the owner's own grant. A statement alone never enrolls a key.
     */
    async enroll(body: unknown): Promise<boolean> {
      const machine = deps.machine();
      const ok = await checked(body, "enroll");
      const host = machine?.relayHostId();
      if (!machine || !ok?.signIn || host === undefined) return false;
      const signIn = machine.signInGrant(ok.signIn);
      const action = enrollAction({
        host,
        device: ok.statement.device,
        nonce: ok.statement.nonce,
      });
      if (
        !signIn ||
        signIn.account !== ok.statement.account ||
        signIn.action !== action ||
        deps.now() - signIn.authAt > ENROLL_SIGN_IN_MS
      )
        return false;
      for (const named of ok.sockets) {
        const generation = live(named)?.grantProven();
        if (generation !== undefined) return machine.addAppKey(ok.key, generation);
      }
      return false;
    },
    /** Signing out: the key is forgotten, and every socket's standing from it ends now. */
    async revoke(key: string): Promise<void> {
      await deps.machine()?.removeAppKey(key);
      for (const socket of sockets.values()) socket.dropApp(key);
    },
  };
}
export type AppStandingDesk = ReturnType<typeof appStandingDesk>;
