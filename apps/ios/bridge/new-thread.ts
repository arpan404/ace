import type { ClientCore } from "@ace/client";
import { WorkspaceId, type Project } from "@ace/protocol";
import {
  baseOptions,
  createPayload,
  defaultWorktreeBase,
  readModelCatalog,
  type ModelCatalog,
} from "@ace/ui-core";
import {
  newThreadAgents,
  newThreadProjects,
  selectNewThreadAgent,
  type NewThreadAgents,
} from "@ace/ui-core/mobile";
import { z } from "zod";
import { submitCommand } from "./commands.ts";
import type { PatchSink, Preview } from "./agents.ts";

/*
 * The New thread sheet on one machine. Reads (projects, coding agents, a project's branches)
 * arrive as `compose.*` patches; Swift sends the person's choices and the bridge decides, by the
 * web's shared rules, whether a thread can start and what `thread.create` carries. The command
 * goes through the SDK's durable outbox under the id Swift keeps with its draft, so sending the
 * same draft again (after a lost reply or the app being killed) replays one command.
 */

export type NewThreadOwner = Pick<
  ClientCore,
  "request" | "enqueue" | "intent" | "commandId" | "cachedThreads"
>;

const id = z.string().min(1).max(128);
export const CreateAction = z.object({
  kind: z.literal("create"),
  /** The draft's command id; the same id for the same draft replays one command. */
  commandId: z.string().min(8).max(64),
  workspaceId: id,
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(512).optional(),
  account: id.optional(),
  effort: z.string().min(1).max(64).optional(),
  mode: z.enum(["local", "worktree"]),
  base: z.object({ ref: z.string().min(1).max(1024), remote: id.optional() }).optional(),
  text: z.string().min(1).max(100_000),
});
type Create = z.infer<typeof CreateAction>;

/** At most this many projects are read and listed. */
const maxProjects = 300;
const quiet = { timeoutMs: 15_000 };

export class NewThread {
  #owner: NewThreadOwner;
  #sink: PatchSink;
  #preview: Preview;
  #now: () => number;
  #agents: NewThreadAgents | undefined;
  /** Each command id once: a repeated send waits on the first. */
  #flights = new Map<string, Promise<void>>();
  constructor(owner: NewThreadOwner, sink: PatchSink, preview: Preview, now: () => number) {
    this.#owner = owner;
    this.#sink = sink;
    this.#preview = preview;
    this.#now = now;
  }

  /** Read the machine's projects and coding agents for a sheet that just opened. */
  open(): void {
    void this.projects();
    void this.agents();
  }

  async projects(): Promise<void> {
    this.#put("compose:projects", { type: "compose.projects", state: "loading", projects: [] });
    try {
      const listed: Project[] = [];
      let after: string | undefined;
      do {
        const reply = await this.#owner.request(
          {
            type: "workspace.request",
            operation: { op: "workspaces.list", limit: 100, ...(after ? { after } : {}) },
          },
          quiet,
        );
        if (reply.result.kind !== "workspaces") throw new Error(reply.result.kind);
        listed.push(...reply.result.workspaces);
        after = reply.result.next;
      } while (after && listed.length < maxProjects);
      const store = this.#owner.cachedThreads();
      const activity = (store?.ids ?? []).flatMap((threadId) => {
        const entry = store?.thread(threadId);
        return entry
          ? [{ workspaceId: entry.workspaceId, at: entry.activityAt ?? entry.updatedAt }]
          : [];
      });
      const projects = newThreadProjects(listed.slice(0, maxProjects), activity).map((row) => ({
        id: row.id,
        name: this.#preview(row.name, 256),
        path: this.#preview(row.path, 1024),
        recent: row.recent,
      }));
      this.#put("compose:projects", { type: "compose.projects", state: "ready", projects });
    } catch {
      this.#put("compose:projects", { type: "compose.projects", state: "failed", projects: [] });
    }
  }

  async agents(): Promise<void> {
    this.#put("compose:agents", { type: "compose.agents", state: "loading", providers: [] });
    try {
      const [readiness, accounts, catalog] = await Promise.all([
        this.#owner.request({ type: "providers.request", operation: "readiness" }, quiet),
        this.#owner
          .request({ type: "accounts.list" }, quiet)
          .then((reply) => reply.accounts)
          .catch(() => []),
        readModelCatalog(this.#owner, {}).catch((): ModelCatalog => ({
          models: [],
          instances: [],
        })),
      ]);
      if (!readiness.result.ok) throw new Error(readiness.result.error);
      const agents = newThreadAgents({
        statuses: readiness.result.providers,
        accounts,
        catalog,
        now: this.#now(),
      });
      this.#agents = agents;
      const start = selectNewThreadAgent(agents, {});
      this.#put("compose:agents", {
        type: "compose.agents",
        state: "ready",
        providers: agents.providers.map((row) => ({
          provider: row.provider,
          name: row.name,
          ready: row.ready,
          status: row.status,
          reason: row.reason ?? null,
          accounts: row.accounts.slice(0, 16).map((account) => ({
            id: account.id,
            label: this.#preview(account.label, 128),
            usage: this.#preview(account.usage, 128),
          })),
          models: row.models.slice(0, 200).map((model) => ({
            key: model.key,
            label: this.#preview(model.label, 128),
            account: model.account,
            efforts: model.efforts,
            defaultEffort: model.defaultEffort ?? null,
          })),
        })),
        start: start.ok
          ? {
              provider: start.provider,
              model: start.model.key,
              account: start.model.account,
              effort: start.effort ?? null,
            }
          : null,
      });
    } catch {
      this.#agents = undefined;
      this.#put("compose:agents", { type: "compose.agents", state: "failed", providers: [] });
    }
  }

  /** A project's branches for a worktree's base, with why it can't have worktrees. */
  async branches(workspaceId: string): Promise<void> {
    const key = "compose:branches";
    const empty = { type: "compose.branches", workspaceId, bases: [], start: null };
    this.#put(key, { ...empty, state: "loading", noWorktree: null });
    try {
      const reply = await this.#owner.request(
        {
          type: "workspace.request",
          operation: { op: "branches.list", workspaceId: WorkspaceId.parse(workspaceId) },
        },
        quiet,
      );
      const result = reply.result;
      if (result.kind === "error" && result.code === "git_not_a_repo") {
        this.#put(key, { ...empty, state: "ready", noWorktree: "Not a Git repository" });
        return;
      }
      if (result.kind !== "branches") throw new Error(result.kind);
      const refs = result.refs ?? result.branches.map((name) => ({ name }));
      const options = baseOptions(refs, result.defaultBranch);
      const start = defaultWorktreeBase(refs, result.defaultBranch);
      this.#put(key, {
        type: "compose.branches",
        workspaceId,
        state: "ready",
        noWorktree: result.unbornHead ? "No commits yet" : null,
        bases: [...options.remote, ...options.local].slice(0, 200).map((option) => ({
          ref: option.base.ref,
          remote: option.base.remote ?? null,
          label: this.#preview(option.label, 256),
          note: option.note ?? null,
        })),
        start: start ? { ref: start.ref, remote: start.remote ?? null } : null,
      });
    } catch {
      this.#put(key, { ...empty, state: "failed", noWorktree: null });
    }
  }

  /**
   * Start the thread. Admission (saved on this phone, or why not) answers on `admission:<id>`;
   * the daemon's receipt, naming the new thread, on `compose.start`.
   */
  create(action: Create): Promise<void> {
    const running = this.#flights.get(action.commandId);
    if (running) return running;
    const flight = this.#create(action).finally(() => this.#flights.delete(action.commandId));
    this.#flights.set(action.commandId, flight);
    return flight;
  }

  async #create(action: Create): Promise<void> {
    const admission = (ok: boolean, message: string) =>
      this.#put(`admission:${action.commandId}`, {
        type: "admission",
        id: action.commandId,
        ok,
        message,
      });
    if (!this.#agents) {
      admission(false, "Still reading this computer's coding agents. Try again in a moment.");
      return;
    }
    const start = selectNewThreadAgent(this.#agents, action);
    if (!start.ok) {
      admission(false, start.reason);
      return;
    }
    const payload = createPayload({
      project: action.workspaceId,
      scope: start.model.scope,
      model: start.model.id,
      mode: action.mode,
      base: action.mode === "worktree" ? action.base : undefined,
      effort: start.effort,
      text: action.text,
    });
    try {
      await submitCommand(
        this.#owner,
        payload,
        () => admission(true, ""),
        (result) =>
          this.#put(`compose:start:${action.commandId}`, {
            type: "compose.start",
            id: action.commandId,
            ok: result.ok,
            threadId: result.threadId ?? null,
            message: result.ok
              ? ""
              : this.#preview(result.error ?? "The thread didn't start", 2048),
          }),
        action.commandId,
      );
    } catch {
      admission(false, "Couldn't save the new thread on this phone. Your draft is still here.");
    }
  }

  #put(key: string, patch: Record<string, unknown>): void {
    this.#sink.put(key, () => patch);
  }
}
