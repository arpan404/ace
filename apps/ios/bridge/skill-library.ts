import type { ClientCore } from "@ace/client";
import {
  SkillAgent,
  SkillHash,
  SkillId,
  SkillSlug,
  WorkspaceId,
  type SkillEntry,
  type SkillOperation,
  type SkillResult,
} from "@ace/protocol";
import {
  agentsText,
  createdBefore,
  editApplied,
  extensionDisplayName,
  formatAgo,
  groupByHome,
  homeLabel,
  initialSkillAgents,
  instructionsShown,
  keptAgentsText,
  lockedAgents,
  nameTaken,
  newSkillPath,
  providerNames,
  rowMarks,
  runsChoices,
  runsText,
  skillAgents,
  skillBody,
  skillNameProblem,
  timesText,
} from "@ace/ui-core";
import { z } from "zod";
import { answerHostOpen, HostOpenRequest } from "./host-open.ts";
import { hostOpenTarget } from "./skill-host-open.ts";

/*
 * The skill library (ADR 0103) for the phone's Skills screens: the list grouped by where each
 * skill lives, one skill's page, the New skill form's checks, and creating, editing, re-linking
 * and deleting. Every word and rule comes from `@ace/ui-core`'s skill-library, the web's too;
 * Swift draws what this returns and sends ids, never paths.
 *
 * A change whose answer is lost to a dropped connection is sent again with `retry`. The daemon
 * guards each with a hash or a name, so the second send can't apply twice: it is refused, and
 * the refusal is checked against the library to tell "my first send applied" from a real clash.
 */

const scope = { workspaceId: WorkspaceId.optional() };
const Scope = z.enum(["personal", "project"]);
export const NativeSkillsRequest = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("library"),
    ...scope,
    project: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("skill"),
    id: SkillId,
    ...scope,
    project: z.string().max(256).optional(),
  }),
  z.object({ type: z.literal("skills.native"), op: z.literal("draft"), ...scope }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("check"),
    name: z.string().max(256),
    scope: Scope,
    ...scope,
  }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("create"),
    name: SkillSlug,
    description: z.string().min(1).max(1024),
    body: z.string().max(262144),
    scope: Scope,
    ...scope,
    agents: z.array(SkillAgent).min(1).max(8),
    manual: z.boolean(),
    retry: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("edit"),
    id: SkillId,
    ...scope,
    expectedHash: SkillHash,
    description: z.string().min(1).max(1024),
    body: z.string().max(262144),
    manual: z.boolean(),
  }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("agents"),
    id: SkillId,
    ...scope,
    agents: z.array(SkillAgent).max(8),
  }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("delete"),
    id: SkillId,
    ...scope,
    expectedHash: SkillHash,
    retry: z.boolean().default(false),
  }),
  z.object({ type: z.literal("skills.native"), op: z.literal("openers"), id: SkillId, ...scope }),
  z.object({
    type: z.literal("skills.native"),
    op: z.literal("open"),
    id: SkillId,
    ...scope,
    app: HostOpenRequest.options[1].shape.app,
  }),
]);
export type NativeSkillsRequest = z.infer<typeof NativeSkillsRequest>;

type Owner = Pick<ClientCore, "request">;
type Operation = z.input<typeof SkillOperation>;
const wait = { timeoutMs: 20_000 };
/** Said when the machine didn't answer: whatever was typed stays on the phone. */
const unreachable = "Couldn't reach the machine. Your changes are still here; try again.";

class Refused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function skills(owner: Owner, operation: Operation, signal: AbortSignal) {
  const reply = await owner.request({ type: "skills.request", operation }, { ...wait, signal });
  return reply.result;
}
function expect<K extends SkillResult["kind"]>(result: SkillResult, kind: K) {
  if (result.kind === "error") throw new Refused(result.code, result.message);
  if (result.kind !== kind)
    throw new Refused("unavailable", "The machine answered something else.");
  return result as Extract<SkillResult, { kind: K }>;
}

const agentRow = (provider: SkillAgent, on: boolean, locked: boolean) => ({
  id: provider,
  name: providerNames[provider],
  on,
  locked,
});

/**
 * What the phone remembers of the library per scope: the New skill form checks names against
 * it, as the web's form checks the list it shows. The daemon's `exists` stays the authority.
 */
export class NativeSkillLibrary {
  readonly #owner: Owner;
  readonly #now: () => number;
  readonly #listed = new Map<string, readonly SkillEntry[]>();
  constructor(owner: Owner, now: () => number) {
    this.#owner = owner;
    this.#now = now;
  }

  async answer(request: NativeSkillsRequest, signal: AbortSignal): Promise<unknown> {
    try {
      return { ok: true, ...(await this.#answer(request, signal)) };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "unreachable", message: unreachable };
    }
  }

  async #list(workspaceId: string | undefined, signal: AbortSignal) {
    const at = workspaceId ? { workspaceId } : {};
    const listed = expect(await skills(this.#owner, { op: "list", ...at }, signal), "list");
    this.#listed.set(workspaceId ?? "", listed.entries);
    return listed;
  }

  async #answer(request: NativeSkillsRequest, signal: AbortSignal): Promise<object> {
    const at = request.workspaceId ? { workspaceId: request.workspaceId } : {};
    switch (request.op) {
      case "library": {
        const listed = await this.#list(request.workspaceId, signal);
        // Plugin skills are listed on their plugin's page, which owns their files (ADR 0103).
        const entries = listed.entries
          .filter((entry) => entry.scope !== "plugin")
          .toSorted((a, b) => a.name.localeCompare(b.name));
        return {
          stale: listed.stale,
          groups: groupByHome(entries.map((entry) => ({ home: entry.scope, entry }))).map(
            (group) => ({
              id: group.home,
              title: homeLabel(group.home, request.project),
              rows: group.members.map((member) => row(member.entry)),
            }),
          ),
        };
      }
      case "skill": {
        const [read, usage] = await Promise.all([
          skills(this.#owner, { op: "read", id: request.id, ...at }, signal),
          skills(this.#owner, { op: "usage", ids: [request.id], ...at }, signal).catch(
            () => undefined,
          ),
        ]);
        const { entry, text } = expect(read, "skill");
        const used =
          usage?.kind === "usage" ? usage.usage.find((each) => each.id === entry.id) : undefined;
        return this.#page(entry, text, request.project, used, request.workspaceId);
      }
      case "draft": {
        const statuses = await this.#owner
          .request({ type: "providers.request", operation: "list" }, { ...wait, signal })
          .catch(() => undefined);
        const result = statuses?.result;
        const installed = result?.ok
          ? result.providers.filter((each) => each.installed === true).map((each) => each.provider)
          : [];
        const chosen = initialSkillAgents(installed);
        return {
          agents: skillAgents.map((agent) => agentRow(agent, chosen.includes(agent), false)),
          runs: runsChoices.map((choice) => ({ manual: choice.manual, label: choice.label })),
          path: newSkillPath("personal", "name"),
        };
      }
      case "check": {
        const name = request.name.trim();
        const entries = this.#listed.get(request.workspaceId ?? "");
        const problem = skillNameProblem(name, (value) => nameTaken(entries, value, request.scope));
        return { problem: problem ?? null, path: newSkillPath(request.scope, name || "name") };
      }
      case "create":
        return this.#create(request, signal);
      case "edit":
        return this.#edit(request, signal);
      case "agents": {
        const reply = expect(
          await skills(
            this.#owner,
            { op: "setAgents", id: request.id, agents: request.agents, ...at },
            signal,
          ),
          "skill",
        );
        const note = keptAgentsText(reply.kept, request.agents, title(reply.entry));
        return {
          hash: reply.entry.hash,
          note: note ? `${note}. It reads the folder the skill is saved in.` : null,
        };
      }
      case "openers":
      case "open":
        return this.#host(request, signal);
      case "delete": {
        const result = await skills(
          this.#owner,
          { op: "delete", id: request.id, expectedHash: request.expectedHash, ...at },
          signal,
        );
        // A retried delete whose first send went through finds nothing left to delete.
        if (request.retry && result.kind === "error" && result.code === "not_found")
          return { deleted: request.id };
        return { deleted: expect(result, "deleted").id };
      }
    }
  }

  /**
   * Open on computer: the machine's editors and file manager, or opening the skill's SKILL.md
   * with one. The skill is found by id on the machine, never by a path the phone sends.
   */
  async #host(
    request: Extract<NativeSkillsRequest, { op: "openers" | "open" }>,
    signal: AbortSignal,
  ): Promise<object> {
    const at = request.workspaceId ? { workspaceId: request.workspaceId } : {};
    const { entry } = expect(
      await skills(this.#owner, { op: "read", id: request.id, ...at }, signal),
      "skill",
    );
    const target = hostOpenTarget(entry, request.workspaceId);
    if (!target) throw new Refused("unavailable", "This skill can't be opened on the computer.");
    const outcome = await answerHostOpen(
      this.#owner,
      request.op === "openers" ? { op: "openers" } : { op: "open", app: request.app, ...target },
    );
    // `host-open.ts` answers with its own `ok`, which wins over the wrapper's.
    return z.record(z.string(), z.unknown()).parse(outcome);
  }

  async #create(request: Extract<NativeSkillsRequest, { op: "create" }>, signal: AbortSignal) {
    if (request.scope === "project" && !request.workspaceId)
      throw new Refused("invalid", "Pick a project first.");
    const result = await skills(
      this.#owner,
      {
        op: "create",
        name: request.name,
        description: request.description.trim(),
        body: request.body,
        scope:
          request.scope === "project" && request.workspaceId
            ? { kind: "project", workspaceId: request.workspaceId }
            : { kind: "personal" },
        agents: request.agents,
        manual: request.manual,
      },
      signal,
    );
    if (request.retry && result.kind === "error" && result.code === "exists") {
      const listed = await this.#list(request.workspaceId, signal);
      const made = createdBefore(listed.entries, request);
      if (made) return { id: made.id };
    }
    return { id: expect(result, "skill").entry.id };
  }

  async #edit(request: Extract<NativeSkillsRequest, { op: "edit" }>, signal: AbortSignal) {
    const at = request.workspaceId ? { workspaceId: request.workspaceId } : {};
    const sent = {
      description: request.description.trim(),
      body: request.body,
      manual: request.manual,
    };
    const result = await skills(
      this.#owner,
      { op: "edit", id: request.id, expectedHash: request.expectedHash, ...sent, ...at },
      signal,
    );
    if (result.kind === "error" && result.code === "conflict") {
      // Either the first send of this edit applied, or someone else changed the skill.
      const now = expect(
        await skills(this.#owner, { op: "read", id: request.id, ...at }, signal),
        "skill",
      );
      if (editApplied(sent, now)) return { hash: now.entry.hash };
      throw new Refused("conflict", "This skill changed on the machine since you opened it.");
    }
    return { hash: expect(result, "skill").entry.hash };
  }

  #page(
    entry: SkillEntry,
    text: string,
    project: string | undefined,
    used:
      | { count: number; last?: { threadId: string; title: string; at: number } | undefined }
      | undefined,
    workspaceId: WorkspaceId | undefined,
  ) {
    const locked = lockedAgents(entry);
    const providers = entry.agents.map((agent) => agent.provider);
    const copies = entry.agents.some((agent) => agent.via === "copy");
    const name = title(entry);
    return {
      id: entry.id,
      title: name,
      description: entry.description,
      editable: entry.editable,
      hash: entry.hash,
      agentsText: copies
        ? `${agentsText(providers)}, each keeps its own copy`
        : agentsText(providers),
      agents: skillAgents.map((agent) =>
        agentRow(agent, providers.includes(agent), locked.includes(agent)),
      ),
      savedIn: homeLabel(entry.scope, project),
      path: entry.scope === "builtin" ? null : entry.path,
      manual: entry.manual,
      runs: runsText(entry),
      runsChoices: runsChoices.map((choice) => ({ manual: choice.manual, label: choice.label })),
      argumentHint: entry.argumentHint ?? null,
      used: !used?.count ? "Not used yet" : timesText(used.count),
      last: used?.last
        ? {
            threadId: used.last.threadId,
            title: used.last.title,
            ago: formatAgo(used.last.at, this.#now()),
          }
        : null,
      instructions: instructionsShown(text, name),
      body: skillBody(text),
      deleteMessage: `This deletes ${entry.path} and its files. Agents stop seeing it.`,
      open: hostOpenTarget(entry, workspaceId),
    };
  }
}

/** A skill's title as the web's pages show it. */
const title = (entry: Pick<SkillEntry, "name" | "title">) =>
  extensionDisplayName(entry.name, entry.title);

function row(entry: SkillEntry) {
  return {
    id: entry.id,
    name: entry.name,
    title: title(entry),
    description: entry.description,
    marks: rowMarks(entry.agents.map((agent) => agent.provider)),
    editable: entry.editable,
    manual: entry.manual,
  };
}
