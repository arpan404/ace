import { AppSocketTag, AppStandingStatement, type AppStandingChallenge } from "@ace/protocol";
import { verifyStatement, type PersonStatement } from "@ace/account-grant/person-statement";

/*
 * The person's standing on the desktop app's own sockets (ADR 0190, amendment 1). The app's main
 * process tags each WebSocket upgrade from the app's own session with a secret header no page
 * sees, then proves for those tags with a person's statement its device key signed over a
 * challenge it fetched itself. A page never hands over a challenge or names a socket, so the
 * statement can reach only sockets main tagged. Enrolling a key takes a socket that proved the
 * owner's grant (a browser sign-in's), never another statement. Signing out revokes the key and
 * every standing it gave.
 */

/** One tagged socket, as the server lets this module touch it. */
export interface AppSocket {
  /** Gives the socket the person's standing from `key`, proven under `generation`. */
  grantApp(key: string, generation: number): boolean;
  /** The owner generation, when the socket proved the owner's own grant (not a statement). */
  grantProven(): number | undefined;
  /** Ends standing this socket took from `key`. */
  dropApp(key: string): void;
}

/** What this reads of the machine's account. */
export interface AppStandingMachine {
  relayHostId(): string | undefined;
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
/** How many tags are remembered as used: a tag names one socket, ever. */
const MAX_SEEN_TAGS = 4096;

export function appStandingDesk(deps: {
  now(): number;
  /** A fresh single-use nonce. */
  nonce(): string;
  machine(): AppStandingMachine | undefined;
}) {
  const sockets = new Map<string, AppSocket>();
  /** Every tag a socket came with lately: a second socket with one gets nothing from it. */
  const seen = new Set<string>();
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
  ): Promise<{ statement: PersonStatement; key: string; tags: string[] } | undefined> => {
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
    const tags = statement.target.split(",");
    if (tags.length > 32 || !tags.every((tag) => AppSocketTag.safeParse(tag).success))
      return undefined;
    return { statement, key: parsed.data.key, tags };
  };
  return {
    /**
     * Keeps `socket` under `tag` until the returned detach runs (its close); undefined for a
     * tag a socket already came with.
     */
    attach(tag: string, socket: AppSocket): (() => void) | undefined {
      // First come only: a socket opened with a tag main already used never takes its place.
      if (seen.has(tag)) return undefined;
      seen.add(tag);
      if (seen.size > MAX_SEEN_TAGS) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      sockets.set(tag, socket);
      return () => {
        if (sockets.get(tag) === socket) sockets.delete(tag);
      };
    },
    /** A single-use challenge; undefined while the machine has no relay host id. */
    challenge(): AppStandingChallenge | undefined {
      const machine = deps.machine();
      const host = machine?.relayHostId();
      if (!machine || host === undefined) return undefined;
      const now = deps.now();
      for (const [nonce, until] of challenges) if (until <= now) challenges.delete(nonce);
      while (challenges.size >= MAX_CHALLENGES) {
        const oldest = challenges.keys().next().value;
        if (oldest === undefined) break;
        challenges.delete(oldest);
      }
      const nonce = deps.nonce();
      challenges.set(nonce, now + CHALLENGE_MS);
      return { nonce, host, owner: machine.ownerAccount() ?? null };
    },
    /** A `standing` statement from a key the owner enrolled: its tagged sockets become theirs. */
    async prove(body: unknown): Promise<number> {
      const machine = deps.machine();
      const generation = machine?.ownerGeneration();
      const ok = await checked(body, "standing");
      if (!machine || generation === undefined || !ok || !machine.appKeys().includes(ok.key))
        return 0;
      let proven = 0;
      for (const tag of ok.tags) if (sockets.get(tag)?.grantApp(ok.key, generation)) proven++;
      return proven;
    },
    /**
     * An `enroll` statement: the key is the owner's from now on, if one of its tagged sockets
     * proved the owner's own grant. A statement alone never enrolls a key.
     */
    async enroll(body: unknown): Promise<boolean> {
      const machine = deps.machine();
      const ok = await checked(body, "enroll");
      if (!machine || !ok) return false;
      for (const tag of ok.tags) {
        const generation = sockets.get(tag)?.grantProven();
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
