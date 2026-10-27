import type { ClientCore } from "@ace/client";
import {
  AccessMode,
  ForgeIssueRef,
  ForgePrWorktree,
  KnownSpeed,
  WorkspaceId,
  type CatalogEntry,
  type CatalogModel,
} from "@ace/protocol";
import {
  baseOptions,
  catalogModelIds,
  createPayload,
  defaultWorktreeBase,
  messageHasContent,
} from "@ace/ui-core";
import { newThreadProjects, selectNewThreadAgent, type NewThreadAgents } from "@ace/ui-core/mobile";
import { z } from "zod";
import { submitCommand } from "./commands.ts";
import { joinContext, messageContent, References } from "./composer-references.ts";
import { readProjects } from "./project-list.ts";
import type { PatchSink, Preview } from "./agents.ts";
import { NewThreadAccessReader, knownProvider } from "./new-thread-access.ts";
import { ModelFavorites } from "./model-favorites.ts";
import { agentsPatch, type Stars } from "./new-thread-agents.ts";
import { readAgents } from "./agent-read.ts";
import type { AttachmentTray } from "./thread-attachments.ts";

/*
 * The New thread sheet on one machine. Reads (projects, coding agents, a project's branches,
 * the chosen agent's access modes) arrive as `compose.*` patches; Swift sends the person's
 * choices and the bridge decides, by the web's shared rules, whether a thread can start and
 * what `thread.create` carries: model, effort, speed, access and the first message's files. The
 * command goes through the SDK's durable outbox under the id Swift keeps with its draft, so
 * sending the same draft again (after a lost reply or the app being killed) replays one command.
 */

export type NewThreadOwner = Pick<
  ClientCore,
  "request" | "enqueue" | "intent" | "commandId" | "cachedThreads"
>;

/** The first message's files: the project's tray, and handing its draft scope to the thread. */
export interface NewThreadFiles {
  tray(workspaceId: string): AttachmentTray | undefined;
  adopt(draftId: string): void;
}
/**
 * The sheet's last project and agent lists (`native-reads.ts`), kept between openings and
 * launches so the sheet opens on them while they are read again.
 */
export interface NewThreadMemory {
  recall(key: string): Record<string, unknown> | undefined;
  keep(key: string, family: "projects" | "catalog", patch: Record<string, unknown>): void;
}

const id = z.string().min(1).max(128);
const choiceFields = {
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(512).optional(),
  account: id.optional(),
  /** A speed turned on for the first turn; omitted runs at the catalog's default. */
  speed: KnownSpeed.optional(),
  /** An access mode picked for this thread; omitted follows the project's and daemon's. */
  access: AccessMode.optional(),
};
export const ChoiceAction = z.object({
  kind: z.literal("choice"),
  workspaceId: id.optional(),
  ...choiceFields,
});
export const CreateAction = z.object({
  kind: z.literal("create"),
  /** The draft's command id; the same id for the same draft replays one command. */
  commandId: z.string().min(8).max(64),
  workspaceId: id,
  ...choiceFields,
  effort: z.string().min(1).max(64).optional(),
  mode: z.enum(["local", "worktree"]),
  base: z.object({ ref: z.string().min(1).max(1024), remote: id.optional() }).optional(),
  /** Empty when the first message carries only files. */
  text: z.string().max(100_000),
  /** The GitHub issue the thread works on, linked as the web's New thread from an issue does. */
  issue: ForgeIssueRef.optional(),
  /** The pull request the thread works on, in a worktree of the head the person saw. */
  pullRequest: ForgePrWorktree.optional(),
  /** Rows picked from `@` and `/`, as inserted (`composer-references.ts`). */
  references: References.optional(),
});
type Create = z.infer<typeof CreateAction>;
type Choice = z.infer<typeof ChoiceAction>;

/** At most this many projects are read and listed. */
const maxProjects = 300;
const quiet = { timeoutMs: 15_000 };

export class NewThread {
  #owner: NewThreadOwner;
  #sink: PatchSink;
  #preview: Preview;
  #now: () => number;
  #files: NewThreadFiles;
  #access: NewThreadAccessReader;
  #agents: NewThreadAgents | undefined;
  #catalog: readonly CatalogModel[] = [];
  #favorites: ModelFavorites;
  #stars: Stars = { keys: [], problem: null };
  #choice: Choice = { kind: "choice" };
  /** Each project's own default access for new threads, from `workspaces.list`. */
  #projectAccess = new Map<string, AccessMode>();
  /** Each command id once: a repeated send waits on the first. */
  #flights = new Map<string, Promise<boolean>>();
  #memory: NewThreadMemory | undefined;
  /** The draft's catalog as the composer last read it, for a typed `/name`. */
  #commands: (workspaceId: string, provider: string) => readonly CatalogEntry[] | undefined = () =>
    undefined;
  constructor(
    owner: NewThreadOwner,
    sink: PatchSink,
    preview: Preview,
    now: () => number,
    files: NewThreadFiles,
    memory?: NewThreadMemory,
  ) {
    this.#owner = owner;
    this.#sink = sink;
    this.#preview = preview;
    this.#now = now;
    this.#files = files;
    this.#memory = memory;
    this.#access = new NewThreadAccessReader(owner, sink);
    this.#favorites = new ModelFavorites(owner);
  }

  /** Read the machine's projects, coding agents and default access for a sheet that opened. */
  open(): void {
    void this.projects();
    void this.agents();
    void this.#access.open();
  }

  /** What the sheet has chosen: the picker leads with it, and its access modes are read. */
  choose(choice: Choice): void {
    this.#choice = choice;
    if (this.#agents) this.#emitAgents(this.#agents);
    void this.#access.target(this.#accessTarget(choice));
  }

  async projects(): Promise<void> {
    // The last list stays on screen while it is read again; only a first read says loading.
    const last = this.#memory?.recall("compose:projects");
    this.#put(
      "compose:projects",
      last ?? { type: "compose.projects", state: "loading", projects: [] },
    );
    try {
      // A chat's hidden project is never one to pick (ADR 0099).
      const listed = await readProjects(
        this.#owner,
        quiet,
        maxProjects,
        (project) => project.kind !== "chat",
      );
      this.#projectAccess.clear();
      for (const project of listed)
        if (project.defaults?.access) this.#projectAccess.set(project.id, project.defaults.access);
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
      const patch = { type: "compose.projects", state: "ready", projects };
      this.#put("compose:projects", patch);
      this.#memory?.keep("compose:projects", "projects", patch);
      void this.#access.target(this.#accessTarget(this.#choice));
    } catch {
      if (!last)
        this.#put("compose:projects", { type: "compose.projects", state: "failed", projects: [] });
    }
  }

  async agents(): Promise<void> {
    // As with projects: the last agents show while they are read again. Starting a thread
    // still waits for this read, so a choice is never checked against an old list.
    const last = this.#memory?.recall("compose:agents");
    this.#put(
      "compose:agents",
      last ?? { type: "compose.agents", state: "loading", providers: [] },
    );
    try {
      const { agents, catalog, stars } = await readAgents(
        this.#owner,
        this.#favorites,
        this.#now(),
      );
      this.#stars = { keys: stars, problem: null };
      this.#agents = agents;
      this.#catalog = catalog.models;
      this.#emitAgents(agents);
      this.#memory?.keep(
        "compose:agents",
        "catalog",
        agentsPatch(agents, this.#choice, this.#preview, this.#stars),
      );
      void this.#access.target(this.#accessTarget(this.#choice));
    } catch {
      this.#agents = undefined;
      if (!last)
        this.#put("compose:agents", { type: "compose.agents", state: "failed", providers: [] });
    }
  }

  /** Star or unstar a model where the web keeps stars; the picker redraws with them saved. */
  async favorite(key: string): Promise<void> {
    try {
      this.#stars = {
        keys: await this.#favorites.toggle(key, catalogModelIds(this.#catalog)),
        problem: null,
      };
    } catch {
      this.#stars = {
        ...this.#stars,
        problem: "Couldn't save this favourite. Reconnect and try again.",
      };
    }
    if (this.#agents) this.#emitAgents(this.#agents);
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
  /** Where a typed `/name` finds its catalog entry (`composer-suggest.ts`). */
  readCatalogFrom(
    catalog: (workspaceId: string, provider: string) => readonly CatalogEntry[] | undefined,
  ): void {
    this.#commands = catalog;
  }

  /** Resolves true once the thread is saved on this phone to start. */
  create(action: Create): Promise<boolean> {
    const running = this.#flights.get(action.commandId);
    if (running) return running;
    const flight = this.#create(action).finally(() => this.#flights.delete(action.commandId));
    this.#flights.set(action.commandId, flight);
    return flight;
  }

  async #create(action: Create): Promise<boolean> {
    const admission = (ok: boolean, message: string) =>
      this.#put(`admission:${action.commandId}`, {
        type: "admission",
        id: action.commandId,
        ok,
        message,
      });
    if (!this.#agents) {
      admission(false, "Still reading this computer's coding agents. Try again in a moment.");
      return false;
    }
    const start = selectNewThreadAgent(this.#agents, action);
    if (!start.ok) {
      admission(false, start.reason);
      return false;
    }
    const tray = this.#files.tray(action.workspaceId);
    if (!messageHasContent(action.text, tray?.size ?? 0)) {
      admission(false, "Write the first message or attach a file.");
      return false;
    }
    const files = tray?.context() ?? { context: undefined, ids: [] };
    if ("refused" in files) {
      admission(false, files.refused);
      return false;
    }
    const access = this.#access.decide({
      provider: start.provider,
      account: start.model.account,
      chosen: action.access,
      projectDefault: this.#projectAccess.get(action.workspaceId),
    });
    if (access.problem) {
      admission(false, access.problem);
      return false;
    }
    const content = messageContent(
      action.text,
      action.references ?? [],
      this.#commands(action.workspaceId, start.provider),
    );
    const payload = createPayload({
      project: action.workspaceId,
      scope: start.model.scope,
      model: start.model.id,
      mode: action.mode,
      base: action.mode === "worktree" ? action.base : undefined,
      effort: start.effort,
      serviceTier: start.serviceTier,
      permission: access.permission,
      text: action.text,
      input: content.input,
      context: joinContext(files.context, content.references),
      ...(action.issue ? { issue: action.issue } : {}),
      ...(action.pullRequest ? { pullRequest: action.pullRequest } : {}),
    });
    const draftId = files.context?.draftId;
    // The new thread takes only these files: none joins until it is saved or refused.
    tray?.lock("Wait for the thread to start, then add files.");
    try {
      await submitCommand(
        this.#owner,
        payload,
        () => {
          // The thread takes the files and their draft scope with it.
          tray?.sent(files.ids);
          if (draftId) this.#files.adopt(draftId);
          admission(true, "");
        },
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
      return true;
    } catch {
      tray?.unlock();
      admission(false, "Couldn't save the new thread on this phone. Your draft is still here.");
      return false;
    }
  }

  #accessTarget(choice: Choice) {
    const start = this.#agents && selectNewThreadAgent(this.#agents, choice);
    const provider = start?.ok ? start.provider : knownProvider(choice.provider);
    return {
      provider,
      account: start?.ok ? start.model.account : choice.account,
      chosen: choice.access,
      projectDefault: choice.workspaceId ? this.#projectAccess.get(choice.workspaceId) : undefined,
    };
  }

  /** The agents and their models, the one in use (else each account's default) first. */
  #emitAgents(agents: NewThreadAgents): void {
    this.#put("compose:agents", agentsPatch(agents, this.#choice, this.#preview, this.#stars));
  }

  #put(key: string, patch: Record<string, unknown>): void {
    this.#sink.put(key, () => patch);
  }
}
