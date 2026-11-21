import { AceOrgPolicyVersion } from "@ace/protocol/ace-org";
import type { GrantKeySet } from "@ace/account-grant";
import { spadeRequest, type SpadeConnection } from "../spade/forward.ts";
import { personStamp, personHeader } from "../spade/person-stamp.ts";
import {
  Outbox,
  SpadeOrgView,
  bindingSteps,
  forwardedAs,
  newerPolicy,
  outgoingEntry,
  type WantedBinding,
} from "./plan.ts";

/*
 * An org host's daemon and its Spade (ADR 0206 §2.1, §3, §4.3). The daemon gives Spade to the
 * organization the machine answers to, stamped as the machine's own say (Spade's `PUT /v1/org`
 * takes only the person stamp, which no agent holding Spade's token can make), and lets it go on
 * release. It fetches the organization's signed policy with the host's credential and offers it
 * to Spade, which applies it only when it verifies and is newer. It drains Spade's audit outbox
 * to the backend in order, each entry idempotent by its hash, retrying later when offline.
 *
 * Every round runs here, off Spade's path: Spade only answers, and nothing it does waits on the
 * backend. One round at a time; a reason to run while one is running runs once more after it.
 */

/** How often a round runs on its own: the outbox often, the policy less so. */
export const orgHostIntervals = { auditMs: 30_000, policyMs: 5 * 60_000 };
/** Entries one outbox read takes, and reads one round makes at most. */
const outboxBatch = 50;
const outboxReads = 20;
const requestMs = 15_000;
const spadeBodyBytes = 4 * 1024 * 1024;

/** The machine account, as the link reads it. */
export interface OrgHostAccount {
  /** Whether the machine's owner was read from disk: until then nothing is let go. */
  ownerKnown(): boolean;
  ownerOrg(): string | undefined;
  /** The host's own sign-in while it is an org host: whom it calls the backend as. */
  orgHostSession(): { origin: string; token: string; name: string | undefined } | undefined;
  relayHostId(): string | undefined;
  grantKeys(): GrantKeySet;
  onChange(listener: () => void): () => void;
}

/** Spade, as the link reads it. */
export interface OrgHostSpade {
  ready(): { connection: SpadeConnection; generation: number } | undefined;
  personKey?(): Uint8Array | undefined;
  subscribe(listener: () => void): () => void;
}

export interface OrgHostLinkOptions {
  account: OrgHostAccount;
  spade: OrgHostSpade;
  fetch: typeof fetch;
  now: () => number;
  nonce: () => string;
  /** Runs `callback` after `ms`; the stop it answers cancels it. */
  delay: (callback: () => void, ms: number) => () => void;
  intervals?: Partial<typeof orgHostIntervals>;
  log?: (error: Error) => void;
}

type Spade = NonNullable<ReturnType<OrgHostSpade["ready"]>>;

/** One call to Spade's API with its token: the status and the JSON it answered. */
async function spadeCall(
  spade: Spade,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const answer = await spadeRequest(
    spade.connection,
    {
      method,
      path,
      ...(body === undefined
        ? {}
        : { body: Buffer.from(JSON.stringify(body)), contentType: "application/json" }),
      ...(headers ? { headers } : {}),
    },
    { signal: AbortSignal.timeout(requestMs), maxBytes: spadeBodyBytes },
  );
  if (answer.kind !== "response") throw new Error(`Spade's answer to ${path} is too large.`);
  const text = answer.body.toString("utf8");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: answer.status, body: parsed };
}

export function orgHostLink(options: OrgHostLinkOptions) {
  const intervals = { ...orgHostIntervals, ...options.intervals };
  let running: Promise<void> | undefined;
  let again = false;
  let wantPolicy = true;
  let closed = false;
  let lastPolicyAt = Number.NEGATIVE_INFINITY;
  let generation: number | undefined;
  /** The newest policy version Spade was seen holding. */
  let heldPolicy = 0;
  /** The Spade run seen belonging to nothing on a machine no organization owns. */
  let unboundSeen: number | undefined;
  let cancel: (() => void) | undefined;
  const open = () => !closed;
  const log = (error: unknown) =>
    options.log?.(error instanceof Error ? error : new Error(String(error)));

  async function backendCall(
    session: NonNullable<ReturnType<OrgHostAccount["orgHostSession"]>>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const response = await options.fetch(`${session.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(requestMs),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  }

  /** The machine's own say on what Spade belongs to: the person stamp over `org` and `value`. */
  function ownSay(value: string): Record<string, string> | undefined {
    const key = options.spade.personKey?.();
    if (!key) return undefined;
    return {
      [personHeader]: personStamp(key, { target: "org", value }, options.now(), options.nonce()),
    };
  }

  /** Spade belongs to `wanted`, or to nothing; its view once it does. */
  async function bind(spade: Spade, wanted: WantedBinding | undefined): Promise<SpadeOrgView> {
    const read = await spadeCall(spade, "GET", "/v1/org");
    let view = SpadeOrgView.parse(read.status === 200 ? read.body : { org: null });
    for (const step of bindingSteps(view, wanted)) {
      if (step === "unbind") {
        const say = ownSay("none");
        if (!say) throw new Error("This ace can't stamp Spade's organization yet.");
        const done = await spadeCall(spade, "DELETE", "/v1/org", undefined, say);
        if (done.status !== 204 && done.status !== 404)
          throw new Error(`Spade kept its organization (${done.status}).`);
        view = { org: null };
        continue;
      }
      if (!wanted) continue;
      const say = ownSay(wanted.org);
      if (!say) throw new Error("This ace can't stamp Spade's organization yet.");
      const done = await spadeCall(
        spade,
        "PUT",
        "/v1/org",
        { ...wanted, keys: options.account.grantKeys().keys },
        say,
      );
      if (done.status !== 200)
        throw new Error(`Spade didn't take its organization (${done.status}).`);
      view = SpadeOrgView.parse(done.body);
    }
    return view;
  }

  /** Offers the organization's current policy to Spade when it is newer than the one held. */
  async function syncPolicy(
    spade: Spade,
    session: NonNullable<ReturnType<OrgHostAccount["orgHostSession"]>>,
    org: string,
    held: number | undefined,
  ) {
    const fetched = await backendCall(session, "GET", `/v1/orgs/${encodeURIComponent(org)}/policy`);
    if (fetched.status !== 200)
      throw new Error(`The organization's policy didn't come (${fetched.status}).`);
    const policy = AceOrgPolicyVersion.parse(fetched.body);
    lastPolicyAt = options.now();
    if (policy.org !== org || !newerPolicy(held, policy)) return;
    const offered = await spadeCall(spade, "PUT", "/v1/org/policy", policy);
    // 409: not newer (another round offered it first) or a statement Spade won't verify, which
    // only the backend can mend; Spade keeps the policy it holds either way.
    if (offered.status !== 200 && offered.status !== 409)
      throw new Error(`Spade didn't take the policy (${offered.status}).`);
    if (offered.status === 200) heldPolicy = Math.max(heldPolicy, policy.version);
  }

  /** Sends Spade's outbox on in order, as far as the backend takes it now. */
  async function forward(
    spade: Spade,
    session: NonNullable<ReturnType<OrgHostAccount["orgHostSession"]>>,
    org: string,
  ) {
    for (let read = 0; read < outboxReads && open(); read++) {
      const outbox = await spadeCall(spade, "GET", `/v1/org/audit/outbox?limit=${outboxBatch}`);
      if (outbox.status !== 200) return;
      const { entries } = Outbox.parse(outbox.body);
      if (entries.length === 0) return;
      let through: number | undefined;
      let stopped = false;
      for (const entry of entries) {
        let status: number;
        try {
          status = (
            await backendCall(
              session,
              "POST",
              `/v1/orgs/${encodeURIComponent(org)}/audit`,
              outgoingEntry(entry),
            )
          ).status;
        } catch (error) {
          log(error);
          status = 0;
        }
        if (forwardedAs(status) === "retry") {
          stopped = true;
          break;
        }
        through = entry.seq;
      }
      if (through !== undefined)
        await spadeCall(spade, "POST", "/v1/org/audit/forwarded", { through });
      if (stopped || entries.length < outboxBatch) return;
    }
  }

  async function round() {
    const spade = options.spade.ready();
    if (!spade || !options.account.ownerKnown()) return;
    const org = options.account.ownerOrg();
    const session = org === undefined ? undefined : options.account.orgHostSession();
    const host = options.account.relayHostId();
    const wanted =
      org !== undefined && host !== undefined
        ? { org, name: session?.name ?? org, host }
        : undefined;
    // An org host whose host id isn't read yet waits for it rather than letting Spade go.
    if (org !== undefined && !wanted) return;
    // A person's machine: once this Spade run is seen free of any organization, nothing to do.
    if (!wanted && unboundSeen === spade.generation) return;
    const view = await bind(spade, wanted);
    unboundSeen = wanted ? undefined : spade.generation;
    heldPolicy = view.policy ?? 0;
    if (!wanted || !session) return;
    const policyDue = wantPolicy || options.now() - lastPolicyAt >= intervals.policyMs;
    if (policyDue) {
      wantPolicy = false;
      await syncPolicy(spade, session, wanted.org, view.policy).catch((error: unknown) => {
        wantPolicy = true;
        log(error);
      });
    }
    await forward(spade, session, wanted.org);
  }

  function schedule() {
    cancel?.();
    if (closed) return;
    cancel = options.delay(() => kick(), intervals.auditMs);
  }

  /** Runs a round now, or once more after the one under way. */
  function kick(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await round().catch(log);
      } while (again && open());
    })().finally(() => {
      running = undefined;
      schedule();
    });
    return running;
  }

  const stops = [
    options.account.onChange(() => {
      wantPolicy = true;
      unboundSeen = undefined;
      void kick();
    }),
    options.spade.subscribe(() => {
      // A Spade that started again is bound and offered the policy again.
      const now = options.spade.ready()?.generation;
      if (now === undefined || now === generation) return;
      generation = now;
      wantPolicy = true;
      void kick();
    }),
  ];

  return {
    /** The first round, and the timer after it. */
    start: () => kick(),
    /** Runs a round now: tests and `ace org` commands wait on it. */
    sync: () => kick(),
    /**
     * A member grant named policy `version` (ADR 0206 §3): fetched before long when it is newer
     * than any this host offered.
     */
    policySeen(version: number) {
      if (version <= heldPolicy) return;
      wantPolicy = true;
      void kick();
    },
    async close() {
      closed = true;
      cancel?.();
      for (const stop of stops) stop();
      await running;
    },
  };
}
export type OrgHostLink = ReturnType<typeof orgHostLink>;
