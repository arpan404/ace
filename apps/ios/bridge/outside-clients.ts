import type { ClientCore } from "@ace/client";
import {
  OutsideScope,
  WorkspaceId,
  type OutsideAccessRequest,
  type OutsideGrantEntry,
  type OutsideOperation,
  type OutsideOutcome,
  type OutsideScreenUse,
  type Project,
  type ServerMessage,
} from "@ace/protocol";
import {
  approvalDecision,
  arrangeGrants,
  clientDomainWords,
  defaultLifetime,
  grantState,
  hostPlatform,
  lifetimeEnd,
  orderedScopes,
  outsideLifetimes,
  projectsWords,
  redirectWords,
  scopeChoices,
  scopeWords,
  screenUseSentence,
  thisMachineWords,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import { readProjects } from "./project-list.ts";
import { refusalCode } from "./fleet-admin.ts";
import {
  AddressOps,
  AddressRefused,
  readAddresses,
  setAddressPath,
  setOwnUrl,
} from "./outside-addresses.ts";

/*
 * Outside MCP clients on one machine, from the phone (ADR 0122). The person approves a client's
 * sign-in here, often while away from the computer: `OutsideWatch` follows the machine's pending
 * sign-ins and screen use for as long as the runtime is connected, so the approval sheet can
 * open from anywhere in the app. `answerOutside` serves Settings › Connected apps (grants,
 * change, revoke) and the sheet's decision. The daemon decides; refusals answer in words.
 */

const quiet = { timeoutMs: 15_000 };
const Expiry = z.enum(["day", "month", "forever"]);
const Projects = z.union([z.literal("all"), z.array(WorkspaceId).min(1).max(256)]);
const Scopes = z.array(OutsideScope).min(1).max(OutsideScope.options.length);
const grantId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

export const NativeOutsideRequest = z.object({
  type: z.literal("native.outside"),
  /** The machine's name, for words such as "Only an administrator of studio can …". */
  machine: z.string().min(1).max(256),
  request: z.discriminatedUnion("op", [
    z.object({ op: z.literal("grants") }),
    /** The machine's projects, for choosing which a client may use. */
    z.object({ op: z.literal("projects") }),
    z.object({ op: z.literal("revoke"), grantId }),
    /** Change a live grant; an omitted field keeps its value. A new expiry counts from now. */
    z.object({
      op: z.literal("update"),
      grantId,
      scopes: Scopes.optional(),
      projects: Projects.optional(),
      expiry: Expiry.optional(),
    }),
    z.object({ op: z.literal("stopScreen"), grantId }),
    z.object({
      op: z.literal("decide"),
      requestId: z.string().min(1).max(128),
      approve: z.boolean(),
      scopes: Scopes.optional(),
      projects: Projects.optional(),
      expiry: Expiry.optional(),
    }),
    /** Connect an app: the addresses, a path's switch and your own URL. */
    ...AddressOps,
  ]),
});
export type NativeOutsideRequest = z.infer<typeof NativeOutsideRequest>;

export type OutsideOwner = Pick<ClientCore, "request">;

/** A refusal in words, by the daemon's code. */
export function outsideRefusal(code: string, machine: string, op: string): string {
  switch (code) {
    case "forbidden":
      return `Only an administrator of ${machine} can manage connected apps.`;
    case "unavailable":
      return `Connected apps aren't running on ${machine}.`;
    case "not_found":
      return op === "decide"
        ? "That sign-in request already ended. Ask the app to sign in again."
        : "That app's access already ended.";
    case "offline":
    case "timeout":
      return `${machine} isn't reachable right now.`;
    default:
      return `${machine} couldn't do that.`;
  }
}

/** One grant as Settings draws it. */
export function grantRow(
  grant: OutsideGrantEntry,
  now: number,
  name: (workspaceId: string) => string | undefined,
) {
  const scopes = orderedScopes(grant.scopes);
  return {
    id: grant.id,
    name: grant.name,
    domain: clientDomainWords(grant.domain),
    verified: grant.domain !== null,
    /** Pasted from `ace mcp enroll` rather than signed in. */
    pasted: grant.clientKind === "cli",
    state: grantState(grant, now),
    access: scopeWords(scopes),
    scopes,
    /** Ticks for changing it: read fixed on, the rest as the grant holds them. */
    choices: scopeChoices([], scopes).map(({ scope, label, note, on, fixed }) => ({
      scope,
      label,
      note,
      on,
      fixed,
    })),
    projects: grant.projects,
    projectsLine: projectsWords(grant.projects, name),
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    lastUsedAt: grant.lastUsedAt,
    revokedAt: grant.revokedAt,
    started: grant.started.length,
    messaged: grant.messaged.length,
  };
}

async function projectNames(owner: OutsideOwner): Promise<Project[]> {
  return readProjects(owner, quiet, 256).catch(() => []);
}
/** Projects a person can pick for a client: a chat's hidden project is never one (ADR 0099). */
const choosable = (projects: readonly Project[]) =>
  projects.filter((project) => project.kind !== "chat").map(({ id, name }) => ({ id, name }));

export async function answerOutside(
  owner: OutsideOwner,
  input: NativeOutsideRequest,
  now: () => number,
): Promise<unknown> {
  const { machine, request } = input;
  const ask = async (operation: OutsideOperation): Promise<OutsideOutcome> =>
    (await owner.request({ type: "outside.request", operation }, quiet)).result;
  try {
    switch (request.op) {
      case "grants": {
        const [outcome, projects] = await Promise.all([ask({ op: "grants" }), projectNames(owner)]);
        const names = new Map<string, string>(
          projects.map((project) => [project.id, project.name]),
        );
        const at = now();
        const { live, ended } = arrangeGrants(outcome.kind === "grants" ? outcome.grants : [], at);
        return {
          ok: true,
          grants: [...live, ...ended].map((grant) => grantRow(grant, at, (id) => names.get(id))),
          projects: choosable(projects),
          expiries,
        };
      }
      case "projects": {
        const projects = await projectNames(owner);
        return { ok: true, projects: choosable(projects) };
      }
      case "revoke":
        await ask({ op: "revoke", grantId: request.grantId });
        return { ok: true };
      case "update":
        await ask({
          op: "update",
          grantId: request.grantId,
          ...(request.scopes ? { scopes: orderedScopes(request.scopes) } : {}),
          ...(request.projects ? { projects: request.projects } : {}),
          ...(request.expiry ? { expiresAt: lifetimeEnd(request.expiry, now()) } : {}),
        });
        return { ok: true };
      case "stopScreen":
        await ask({ op: "stopScreen", grantId: request.grantId });
        return { ok: true };
      case "decide":
        await ask({
          op: "decide",
          accessRequestId: request.requestId,
          choice: request.approve
            ? approvalDecision(
                {
                  scopes: new Set(request.scopes ?? []),
                  projects: request.projects ?? "all",
                  lifetime: request.expiry ?? defaultLifetime,
                },
                now(),
              )
            : { decision: "deny" },
        });
        return { ok: true };
      case "addresses":
        return await readAddresses(owner);
      case "setPath":
        return await setAddressPath(owner, request.path, request.on);
      case "setPublicUrl":
        return await setOwnUrl(owner, request.url);
    }
  } catch (error) {
    if (error instanceof AddressRefused)
      return { ok: false, code: "invalid", message: error.message };
    const code = refusalCode(error);
    return { ok: false, code, message: outsideRefusal(code, machine, request.op) };
  }
}

/** The lifetimes the person picks from, as the sheet and Settings list them. */
const expiries = outsideLifetimes.map(({ value, label }) => ({ id: value, label }));

/** One pending sign-in as the approval sheet draws it. */
export function accessRow(request: OutsideAccessRequest, preview: Preview) {
  return {
    requestId: request.requestId,
    clientName: preview(request.clientName, 256),
    domain: clientDomainWords(request.domain),
    verified: request.domain !== null,
    matchCode: request.matchCode,
    expiresAt: request.expiresAt,
    /** Where the code goes once approved ("Signs in to claude.ai"), or a warning; null if unsaid. */
    redirect: redirectWords(request) ?? null,
    choices: scopeChoices(request.scopes),
    expiries,
    expiry: defaultLifetime,
  };
}

type WatchOwner = Pick<ClientCore, "request" | "connectionState" | "onMessage" | "state">;

/**
 * The person tapped a sign-in alert (`AccessAlert` on the phone): open the sheet for that
 * request, or say it ended. The alert's own fields come along, since the machine may not have
 * said anything yet.
 */
export const OutsideOpenAction = z.object({
  type: z.literal("outside.open"),
  requestId: z.string().min(1).max(128),
  clientName: z.string().min(1).max(256),
  expiresAt: z.number().nonnegative(),
});
export type OutsideOpenAction = z.infer<typeof OutsideOpenAction>;

/** What became of the last tapped alert; `n` counts taps, so each one is answered once. */
interface Opened {
  n: number;
  requestId: string;
  /** Null: the sheet opens on it. Otherwise why it can't. */
  ended: string | null;
}

/**
 * Follows a machine's pending sign-ins and outside screen use while the runtime is connected:
 * asks to watch on every ready connection and draws each `outside.state` as one patch. A
 * machine that refuses (this phone isn't its administrator, or it has no outside endpoint) is
 * not asked again until the runtime starts over. Nothing shows while disconnected, since no
 * decision could reach the machine.
 */
export class OutsideWatch {
  static readonly key = "outside:state";
  #owner: WatchOwner;
  #sink: PatchSink;
  #preview: Preview;
  #access: OutsideAccessRequest[] = [];
  #screen: OutsideScreenUse[] = [];
  #refused = false;
  /** Whether the machine says it is a Mac; undefined until read for a screen line. */
  #mac: boolean | undefined;
  #stops: (() => void)[] = [];
  #now: () => number;
  /** Whether the machine has said what is pending since this connection began. */
  #heard = false;
  /** A tapped alert waiting for the machine to say what is pending. */
  #opening: OutsideOpenAction | undefined;
  #opened: Opened | null = null;
  #taps = 0;
  constructor(owner: WatchOwner, sink: PatchSink, preview: Preview, now: () => number) {
    this.#owner = owner;
    this.#sink = sink;
    this.#preview = preview;
    this.#now = now;
  }
  /**
   * A tapped sign-in alert. Opens the sheet on it as soon as the machine lists it; once the
   * machine has said what is pending without it, or it has run out, the phone says it ended
   * instead of drawing a sheet nobody can answer.
   */
  open(action: OutsideOpenAction): void {
    this.#opening = action;
    this.#settleOpening();
  }
  #settleOpening(): void {
    const opening = this.#opening;
    if (!opening) return;
    const pending = this.#access.some((request) => request.requestId === opening.requestId);
    const over = opening.expiresAt <= this.#now();
    if (!pending && !over && !this.#heard && !this.#refused) return;
    this.#opening = undefined;
    this.#opened = {
      n: ++this.#taps,
      requestId: opening.requestId,
      ended:
        pending && !over
          ? null
          : `${this.#preview(opening.clientName, 256)}'s sign-in request ended. Ask it to sign in again.`,
    };
    this.#put();
  }
  start(): void {
    if (this.#stops.length) return;
    const connection = this.#owner.connectionState();
    this.#stops.push(
      this.#owner.onMessage((message) => this.#receive(message)),
      connection.subscribe(() => {
        if (connection.getSnapshot() === "ready") void this.#watch();
        else this.#clear();
      }),
    );
    if (this.#owner.state === "ready") void this.#watch();
  }
  stop(): void {
    for (const stop of this.#stops.splice(0)) stop();
    this.#clear();
  }
  async #watch(): Promise<void> {
    if (this.#refused) return;
    this.#mac = undefined;
    try {
      await this.#owner.request({ type: "outside.request", operation: { op: "watch" } }, quiet);
    } catch (error) {
      const code = refusalCode(error);
      if (code === "forbidden" || code === "unavailable" || code === "protocol") {
        this.#refused = true;
        this.#settleOpening();
      }
    }
  }
  #receive(message: ServerMessage): void {
    if (message.type !== "outside.state") return;
    this.#access = message.access;
    this.#screen = message.screen;
    this.#heard = true;
    if (this.#screen.length && this.#mac === undefined) void this.#readPlatform();
    this.#put();
    this.#settleOpening();
  }
  async #readPlatform(): Promise<void> {
    try {
      const reply = await this.#owner.request({ type: "host.identity" }, quiet);
      this.#mac = hostPlatform(reply.identity.platform) === "darwin";
    } catch {
      this.#mac = false;
    }
    this.#put();
  }
  #clear(): void {
    this.#heard = false;
    if (!this.#access.length && !this.#screen.length) return;
    this.#access = [];
    this.#screen = [];
    this.#put();
  }
  #put(): void {
    const access = this.#access;
    const screen = this.#screen;
    const preview = this.#preview;
    const mac = this.#mac ?? false;
    const opened = this.#opened;
    this.#sink.put(OutsideWatch.key, () => ({
      type: "outside.state",
      access: access.map((request) => accessRow(request, preview)),
      screen: screen.map((use) => ({
        grantId: use.grantId,
        name: preview(use.name, 256),
        apps: use.apps.map((app) => preview(app, 256)),
        /** "Claude is using this Mac", one line per client. */
        line: screenUseSentence([use.name], thisMachineWords(mac)),
      })),
      opened,
      /** Said over a live connection; false after it drops, when nothing is known. */
      live: this.#heard,
    }));
  }
}
