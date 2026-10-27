import type { ClientCore } from "@ace/client";
import type { ProviderInstallProgress, RegistryAgent } from "@ace/protocol";
import { manualAgent } from "@ace/ui-core";
import {
  latestInstallation,
  planFacts,
  registryAge,
  registryFailure,
  registryPublisher,
  registrySetup,
  registryStanding,
  searchRegistry,
  type PlanFact,
} from "@ace/ui-core/acp-registry";
import {
  planInstall,
  readRegistry,
  refreshRegistry,
  RegistryError,
  type RegistryView,
} from "@ace/ui-core/acp-registry-data";
import { z } from "zod";

/*
 * Settings' ACP registry on the phone: browse and search the registry, an entry's page with its
 * install plan and set-up steps, install or update through the daemon's provider installer (so
 * the agent joins Providers and Accounts as on the web), and add an agent the registry doesn't
 * list by its command (`registry.bind`, a `local:` binding the owner approves). Words come from
 * `@ace/ui-core/acp-registry`; Swift draws them.
 */

const agentId = z.string().min(1).max(256);
const session = z.string().min(1).max(128);
const manual = { name: z.string().max(256), command: z.string().max(8192) };
export const RegistryScreenRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("acp.registry"), query: z.string().max(256).default("") }),
  z.object({ type: z.literal("acp.registry.refresh") }),
  z.object({ type: z.literal("acp.registry.agent"), acpAgentId: agentId }),
  z.object({
    type: z.literal("acp.registry.install"),
    acpAgentId: agentId,
    action: z.enum(["install", "update"]),
  }),
  z.object({ type: z.literal("acp.registry.progress"), session }),
  z.object({ type: z.literal("acp.registry.cancel"), session }),
  z.object({ type: z.literal("acp.manual.check"), ...manual }),
  z.object({ type: z.literal("acp.manual.add"), ...manual }),
]);
export type RegistryScreenRequest = z.infer<typeof RegistryScreenRequest>;

/** One registry row: name, publisher, what it is, and only when it matters, where it stands. */
export interface RegistryRow {
  id: string;
  name: string;
  publisher: string;
  description: string;
  version: string;
  /** "Installed", "Update available", why it can't install here; null when it can. */
  standing: string | null;
  tone: "needsYou" | "muted" | null;
  unavailable: boolean;
}

export interface RegistryScreen {
  rows: RegistryRow[];
  /** "Updated 5m ago", or that this is the saved list. */
  age: string;
  /** What to say when no row shows. */
  empty: string | null;
  /** The list is stale or older than ten minutes: download it again behind the list. */
  revalidate: boolean;
}

const revalidateAfterMs = 10 * 60_000;

function row(agent: RegistryAgent, view: RegistryView): RegistryRow {
  const standing = registryStanding(agent, view.installations);
  return {
    id: agent.acpAgentId,
    name: agent.name,
    publisher: registryPublisher(agent.authors),
    description: agent.description,
    version: agent.version,
    standing:
      standing.kind === "available"
        ? null
        : standing.kind === "unavailable"
          ? standing.reason
          : standing.update
            ? "Update available"
            : "Installed",
    tone:
      standing.kind === "installed" && standing.update
        ? "needsYou"
        : standing.kind === "installed"
          ? "muted"
          : null,
    unavailable: standing.kind === "unavailable",
  };
}

/** The registry for one search: matches by name first, what can't install here last. */
export function registryScreen(view: RegistryView, query: string, now: number): RegistryScreen {
  const rows = searchRegistry(view.agents, query).map((agent) => row(agent, view));
  const empty =
    view.agents.length === 0
      ? view.refreshFailed
        ? "Couldn't reach the ACP registry. Check the connection."
        : "The registry is empty."
      : rows.length === 0
        ? `No agents match “${query.trim()}”.`
        : null;
  return {
    rows: [...rows.filter((entry) => !entry.unavailable), ...rows.filter((e) => e.unavailable)],
    age:
      view.refreshFailed && view.agents.length > 0
        ? "Couldn't reach the registry · Showing the saved list"
        : registryAge(view.fetchedAt, now),
    empty,
    revalidate:
      view.stale || view.fetchedAt === undefined || now - view.fetchedAt > revalidateAfterMs,
  };
}

export interface RegistryAgentScreen {
  id: string;
  name: string;
  publisher: string;
  description: string;
  version: string;
  homepage: string | null;
  license: string | null;
  standing: string | null;
  /** What the main button does here; null when nothing can be installed. */
  action: "install" | "update" | null;
  actionLabel: string | null;
  installed: string | null;
  setup: { run: string | null; prompt: string | null; note: string | null };
  facts: PlanFact[];
  /** Why the plan couldn't be made, in fixed words. */
  planProblem: string | null;
}

/** An entry's page: what it is, where it stands here, how to set it up and what install runs. */
export function registryAgentScreen(
  agent: RegistryAgent,
  view: RegistryView,
  plan: { facts: PlanFact[] } | { problem: string } | undefined,
): RegistryAgentScreen {
  const standing = registryStanding(agent, view.installations);
  const action =
    standing.kind === "available"
      ? "install"
      : standing.kind === "installed" && standing.update
        ? "update"
        : null;
  const setup = registrySetup(agent.loginHint);
  return {
    id: agent.acpAgentId,
    name: agent.name,
    publisher: registryPublisher(agent.authors),
    description: agent.description,
    version: agent.version,
    homepage: agent.homepage ?? null,
    license: agent.license ?? null,
    standing: row(agent, view).standing,
    action,
    actionLabel: action === "install" ? "Install" : action === "update" ? "Update" : null,
    installed: latestInstallation(agent.acpAgentId, view.installations)?.version ?? null,
    setup: { run: setup.run ?? null, prompt: setup.prompt ?? null, note: setup.note ?? null },
    facts: plan && "facts" in plan ? plan.facts : [],
    planProblem: plan && "problem" in plan ? plan.problem : null,
  };
}

export interface InstallScreen {
  session: string;
  state: ProviderInstallProgress["state"];
  finished: boolean;
  succeeded: boolean;
  /** "Installing", "Installed", or what went wrong and what to do. */
  title: string;
  /** The installer's latest line while it runs. */
  detail: string | null;
}

const installWords: Record<ProviderInstallProgress["state"], string> = {
  planning: "Preparing",
  running: "Installing",
  verifying: "Checking the install",
  succeeded: "Installed",
  failed: "The install didn't finish. Agents you already have still work; try again.",
  cancelled: "Install cancelled. Nothing was changed.",
  needs_admin: "This install needs an administrator on the computer running ace.",
};

export function installScreen(progress: ProviderInstallProgress): InstallScreen {
  const finished = ["succeeded", "failed", "cancelled", "needs_admin"].includes(progress.state);
  return {
    session: progress.session,
    state: progress.state,
    finished,
    succeeded: progress.state === "succeeded",
    title:
      progress.state === "failed" || progress.state === "needs_admin"
        ? (progress.message ?? installWords[progress.state])
        : installWords[progress.state],
    detail: finished ? null : (progress.lines.at(-1) ?? null),
  };
}

type Owner = Pick<ClientCore, "registry" | "request">;
type Reply = { ok: true; [key: string]: unknown } | { ok: false; problem: string };

const failed = (error: unknown): Reply => ({
  ok: false,
  problem:
    error instanceof RegistryError ? error.message : "Couldn't reach the machine. Try again.",
});

async function install(owner: Owner, request: RegistryScreenRequest, signal: AbortSignal) {
  const options = { signal, timeoutMs: 20_000 };
  const reply =
    request.type === "acp.registry.install"
      ? await owner.request(
          {
            type: "provider.install.run",
            provider: "acp",
            acpAgentId: request.acpAgentId,
            action: request.action,
            method: "registry",
          },
          options,
        )
      : request.type === "acp.registry.progress"
        ? await owner.request({ type: "provider.install.poll", session: request.session }, options)
        : request.type === "acp.registry.cancel"
          ? await owner.request(
              { type: "provider.install.cancel", session: request.session },
              options,
            )
          : undefined;
  const result = reply?.result;
  if (!result?.ok || !("progress" in result))
    return {
      ok: false as const,
      problem:
        result && !result.ok && result.error === "busy"
          ? "Another agent is installing. Try again once it finishes."
          : result && !result.ok && result.error === "forbidden"
            ? "This device can't install agents. Use the computer running ace."
            : "The install didn't start. Try again.",
    };
  return { ok: true as const, install: installScreen(result.progress) };
}

/** Answers one registry screen request through the daemon. */
export async function answerRegistryScreen(
  owner: Owner,
  request: RegistryScreenRequest,
  signal: AbortSignal,
  now: number,
): Promise<Reply> {
  try {
    switch (request.type) {
      case "acp.registry":
        return {
          ok: true,
          screen: registryScreen(await readRegistry(owner, signal), request.query, now),
        };
      case "acp.registry.refresh":
        await refreshRegistry(owner);
        return { ok: true };
      case "acp.registry.agent": {
        const view = await readRegistry(owner, signal);
        const agent = view.agents.find((entry) => entry.acpAgentId === request.acpAgentId);
        if (!agent) return { ok: false, problem: "This agent left the registry. Refresh it." };
        const screen = registryAgentScreen(agent, view, undefined);
        if (!screen.action) return { ok: true, agent: screen };
        const plan = await planInstall(owner, agent).then(
          (value) => ({ facts: planFacts(value, agent.name) }),
          (error: unknown) => ({
            problem: error instanceof RegistryError ? error.message : registryFailure(""),
          }),
        );
        return { ok: true, agent: registryAgentScreen(agent, view, plan) };
      }
      case "acp.registry.install":
      case "acp.registry.progress":
      case "acp.registry.cancel":
        return await install(owner, request, signal);
      case "acp.manual.check": {
        const check = manualAgent(request.name, request.command);
        return check.ok
          ? { ok: true, display: check.agent.display, field: null }
          : { ok: true, problem: check.problem, field: check.field };
      }
      case "acp.manual.add": {
        const check = manualAgent(request.name, request.command);
        if (!check.ok) return { ok: false, problem: check.problem };
        const { name: _name, display: _display, ...binding } = check.agent;
        const reply = await owner.registry({ type: "registry.bind", ...binding }, { signal });
        if (reply.result.ok) return { ok: true, name: check.agent.name };
        return {
          ok: false,
          problem: reply.result.reason.endsWith("scope required")
            ? registryFailure(reply.result.reason)
            : "ace couldn't add that command. Check it's installed on the computer running ace and isn't already added.",
        };
      }
    }
  } catch (error) {
    return failed(error);
  }
}
