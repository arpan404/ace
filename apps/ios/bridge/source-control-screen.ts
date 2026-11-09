import type { ClientCore } from "@ace/client";
import {
  ForgeKind,
  SourceControlPreferences,
  WorkspaceId,
  type SourceControlReadiness,
} from "@ace/protocol";
import { originApiHost, publicForgeHosts } from "@ace/protocol/forge";
import { defaultForgeHost, forgeNames, forgeOrder, hostForge } from "@ace/ui-core";
import { z } from "zod";

/*
 * Settings › Source control on the phone, as the web's page: each saved Git host with its
 * provider, the active host's CLI and API state in words, and writes that change only what the
 * screen edits. Editing a host and choosing which host requests use are separate writes. A saved
 * host keeps every field the phone doesn't edit, including a provider or field this build
 * doesn't know. Swift draws.
 */

export const SourceControlScreenRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("source-control.screen"),
    workspaceId: WorkspaceId.optional(),
    fresh: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("source-control.write"),
    change: z.discriminatedUnion("kind", [
      /** Adds a host (no `original`) or replaces the one saved as `original`. */
      z.object({
        kind: z.literal("host"),
        original: z.string().max(256).optional(),
        forge: z.string().min(1).max(64),
        host: z.string().max(256),
        account: z.string().max(256),
      }),
      z.object({ kind: z.literal("use"), host: z.string().max(256) }),
      z.object({ kind: z.literal("remote"), remote: z.string().max(256) }),
    ]),
  }),
]);
export type SourceControlScreenRequest = z.infer<typeof SourceControlScreenRequest>;

/** How far ace reaches a provider: everything, read-only in Code review, or not yet. */
export type HostSupport = "full" | "browse" | "pending";

const support = (forge: string): HostSupport =>
  forge === "github" ? "full" : forge === "gitlab" || forge === "origin" ? "browse" : "pending";
const known = (forge: string): ForgeKind | undefined => ForgeKind.safeParse(forge).data;
/** A provider this build doesn't know is shown by its own id. */
const nameOf = (forge: string): string => {
  const kind = known(forge);
  return kind ? forgeNames[kind] : forge;
};
const cliOf = (forge: string): string =>
  forge === "gitlab" ? "glab" : forge === "origin" ? "origin" : "gh";

/** A saved host as the settings value holds it, every field kept. */
const RawHost = z.looseObject({
  host: z.string(),
  forge: z.string().optional(),
  account: z.string().optional(),
});
const RawPreferences = z.looseObject({
  hosts: z.array(RawHost),
  host: z.string(),
  remote: z.string(),
});
type RawHost = z.infer<typeof RawHost>;
type RawPreferences = z.infer<typeof RawPreferences>;

/** The provider a saved host names; entries saved before providers existed follow `hostForge`. */
const forgeOf = (entry: RawHost): string => {
  if (entry.forge !== undefined) return entry.forge;
  return hostForge({ host: entry.host });
};

function apiWords(status: SourceControlReadiness, expected: string | undefined): string {
  if (status.api === "ready") return `Signed in as ${status.account ?? "unknown"}`;
  if (status.api === "account_mismatch")
    return `Signed in as ${status.account ?? "no account"}, expected ${expected ?? "another account"}`;
  if (status.api === "login_required") return "Not signed in";
  // Network and quota answers, never a sign-in problem.
  if (status.api === "offline") return "Host unreachable";
  if (status.api === "rate_limited") return "API rate limit reached";
  return status.cli === "available" ? "API unavailable" : "CLI not installed";
}

const transportWords: Record<SourceControlReadiness["transport"], string> = {
  unchecked: "Not checked",
  ready: "Ready",
  failed: "Failed",
  no_remote: "No remote",
};

/** The screen Swift draws from one readiness answer. Pure. */
export function sourceControlScreen(status: SourceControlReadiness) {
  const active = status.preferences.host;
  const hosts = status.preferences.hosts.map((entry) => {
    const forge = forgeOf(entry);
    return {
      host: entry.host,
      forge,
      name: nameOf(forge),
      account: entry.account ?? null,
      active: entry.host === active,
      support: support(forge),
    };
  });
  const current = hosts.find((entry) => entry.active);
  const forge = current?.forge ?? hostForge({ host: active });
  const name = nameOf(forge);
  const checks = support(forge) !== "pending";
  return {
    host: active,
    remote: status.preferences.remote,
    hosts,
    status: {
      forge,
      name,
      cli: {
        title: `${name} ${checks ? "CLI" : "connection"}`,
        value: !checks
          ? "API support pending"
          : status.cli === "available"
            ? `${cliOf(forge)} ${status.version ?? ""}`.trim()
            : "Not installed",
      },
      api: {
        title: `${name} API`,
        value: checks ? apiWords(status, current?.account ?? undefined) : "Not available yet",
      },
      accounts: status.accounts.map((entry) => ({ login: entry.login, active: entry.active })),
      note:
        support(forge) === "browse"
          ? "Pull request details and changed files are available in Code review. Reviews and merge actions open on the host."
          : null,
      // What to do next; when everything is ready the rows already say so.
      instructions: status.api === "ready" ? null : status.instructions,
    },
    transport: {
      value: transportWords[status.transport],
      instructions: status.transportInstructions,
    },
    /** The providers a host can be saved under, in the order settings lists them. */
    providers: forgeOrder.map((kind) => ({
      forge: kind,
      name: forgeNames[kind],
      host: defaultForgeHost(kind),
      /** Origin is one hosted service; its host can't change. */
      fixedHost: kind === "origin",
      hostHint:
        kind === "github"
          ? "github.com, or a GitHub Enterprise hostname."
          : `The hostname of your ${forgeNames[kind]} installation.`,
      support: support(kind),
    })),
  };
}
export type SourceControlScreen = ReturnType<typeof sourceControlScreen>;

type Change = Extract<SourceControlScreenRequest, { type: "source-control.write" }>["change"];

/**
 * The saved preferences after one change, or a problem in words. Only the fields the change
 * names are written; every host comes back with its provider spelled out. Pure.
 */
export function changedPreferences(
  saved: RawPreferences,
  change: Change,
): { value: RawPreferences } | { problem: string } {
  // A host saved without a provider is written back with the one it has always meant.
  const hosts = saved.hosts.map((entry) => ({ ...entry, forge: forgeOf(entry) }));
  let next: RawPreferences = { ...saved, hosts };
  if (change.kind === "host") {
    const forge = change.forge;
    const host = forge === "origin" ? originApiHost : change.host.trim().toLowerCase();
    const account = change.account.trim();
    if (!host) return { problem: "Enter the host's name." };
    const fixed = publicForgeHosts[host];
    if (fixed && fixed !== forge)
      return { problem: `${host} is ${forgeNames[fixed]}. Choose ${forgeNames[fixed]} for it.` };
    if (hosts.some((entry) => entry.host === host && entry.host !== change.original))
      return { problem: `${host} is already saved.` };
    const index = hosts.findIndex((entry) => entry.host === change.original);
    const entry: (typeof hosts)[number] = { ...hosts[index], host, forge };
    if (account) entry.account = account;
    else delete entry.account;
    const edited = index < 0 ? [...hosts, entry] : hosts.with(index, entry);
    // Renaming the active host keeps it active.
    next = {
      ...next,
      hosts: edited,
      host: change.original !== undefined && saved.host === change.original ? host : saved.host,
    };
  } else if (change.kind === "use") {
    if (!hosts.some((entry) => entry.host === change.host))
      return { problem: "That host isn't saved any more. Rescan and try again." };
    next = { ...next, host: change.host };
  } else {
    next = { ...next, remote: change.remote.trim() };
  }
  // A provider this build doesn't know is left for the machine to judge.
  const judged = next.hosts.every((entry) => known(entry.forge ?? "") !== undefined);
  if (judged && !SourceControlPreferences.safeParse(next).success)
    return { problem: "Enter a valid hostname, account and remote name." };
  return { value: next };
}

type Owner = Pick<ClientCore, "request">;
const quiet = { timeoutMs: 20_000 };
const unreachable = "Couldn't reach the machine. Check the connection and retry.";

async function readScreen(owner: Owner, workspaceId: string | undefined, signal: AbortSignal) {
  const reply = await owner.request(
    {
      type: "source-control.request",
      operation: { op: "readiness", ...(workspaceId ? { workspaceId } : {}) },
    },
    { ...quiet, signal },
  );
  if (reply.result.kind !== "readiness")
    return { ok: false, problem: `Couldn't check source control: ${reply.result.code}` };
  return { ok: true, screen: sourceControlScreen(reply.result.readiness) };
}

async function write(owner: Owner, change: Change, signal: AbortSignal) {
  const read = await owner.request(
    { type: "settings.get", key: "sourceControl.preferences", scope: {} },
    { ...quiet, signal },
  );
  const entry = read.entries.find((item) => item.key === "sourceControl.preferences");
  const saved = RawPreferences.safeParse(entry?.value);
  if (!read.ok || !saved.success)
    return { ok: false, problem: "Couldn't read the saved preferences. Rescan and try again." };
  const next = changedPreferences(saved.data, change);
  if ("problem" in next) return { ok: false, problem: next.problem };
  const reply = await owner.request(
    {
      type: "settings.set",
      key: "sourceControl.preferences",
      layer: { kind: "global" },
      value: next.value,
    },
    { ...quiet, signal },
  );
  if (!reply.ok)
    return {
      ok: false,
      problem: reply.diagnostics[0]?.message
        ? `Couldn't save source control preferences. ${reply.diagnostics[0].message}`
        : "Couldn't save source control preferences.",
    };
  return { ok: true };
}

export async function answerSourceControlScreen(
  owner: Owner,
  request: SourceControlScreenRequest,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    if (request.type === "source-control.screen")
      return await readScreen(owner, request.workspaceId, signal);
    return await write(owner, request.change, signal);
  } catch {
    return { ok: false, problem: unreachable };
  }
}
