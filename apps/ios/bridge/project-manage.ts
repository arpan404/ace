import type { ClientCore } from "@ace/client";
import {
  BadgeColor,
  CommandPayload,
  Project,
  ProjectDefaults,
  ProjectGlyph,
  ProjectNoteEdit,
  ProviderKind,
  WorkspaceId,
  maxProjectNotes,
} from "@ace/protocol";
import {
  accessDescription,
  accessLabel,
  accessModes,
  newThreadOptions,
  projectBrowserProfiles,
  projectGlyphIcons,
  projectDefaultModels,
  projectEdit,
  projectInitials,
  projectProblem,
  providerNames,
  readModelCatalog,
  type ModelCatalog,
} from "@ace/ui-core";
import { z } from "zod";
import { submitCommand } from "./commands.ts";
import { FolderRequest, ProjectFolders } from "./project-folders.ts";
import { answerHostOpen, HostOpenRequest } from "./host-open.ts";
import { Repositories, RepositoryRequest } from "./repositories.ts";
import { ProjectScripts, ScriptRequest } from "./project-scripts.ts";

/*
 * Managing a project from the phone, as the web's Edit project and Remove dialogs do: what a
 * project can default to (its models and branches), saving an edit (`projectEdit` decides what
 * differs) and removing it from ace. Writes go through the SDK's durable outbox and answer once
 * the daemon took or refused them, with its refusal in the web's words.
 */

const quiet = { timeoutMs: 15_000 };
/** How long a write waits for the daemon before saying it is saved here and will be applied. */
const receiptWait = 20_000;

const IconChoice = z.object({
  mode: z.enum(["auto", "initials", "glyph", "image"]),
  color: BadgeColor.optional(),
  glyph: ProjectGlyph,
  image: z.string().max(131072).optional(),
});
const Draft = z.object({
  name: z.string().max(1024),
  icon: IconChoice.optional(),
  defaults: z.unknown().optional(),
  notes: z
    .array(ProjectNoteEdit.extend({ text: z.string().max(8192) }))
    .max(maxProjectNotes)
    .optional(),
});

export const NativeProjectRequest = z.object({
  type: z.literal("native.project"),
  request: z.discriminatedUnion("op", [
    z.object({
      op: z.literal("options"),
      workspaceId: WorkspaceId,
      /** The saved default model, offered even when the catalog no longer lists it. */
      current: z
        .object({ provider: ProviderKind.optional(), model: z.string().max(256).optional() })
        .default({}),
    }),
    z.object({ op: z.literal("save"), project: Project, draft: Draft }),
    /** The badge's initials for a name the person is typing. */
    z.object({ op: z.literal("initials"), name: z.string().max(1024) }),
    z.object({
      op: z.literal("remove"),
      workspaceId: WorkspaceId,
      stopRunning: z.boolean().default(false),
    }),
    /** A queued write's eventual receipt: taken or refused. */
    z.object({ op: z.literal("outcome"), writeId: z.string().min(1).max(128) }),
    ...FolderRequest.options,
    ...HostOpenRequest.options,
    ...RepositoryRequest.options,
    ...ScriptRequest.options,
  ]),
});
export type NativeProjectRequest = z.infer<typeof NativeProjectRequest>;

/** How a write ended: taken (or saved here, `queued`), else the daemon's code and words. */
/** A queued write's receipt once it came, and the polls waiting for it meanwhile. */
interface Kept {
  outcome: Settled | undefined;
  waiters: Set<(outcome: Settled) => void>;
}

/** A write the daemon answered: taken, or refused with its code and words. */
type Settled =
  | { ok: true; queued: false; terminalId?: string }
  | { ok: false; code: string; message: string };
export type WriteOutcome =
  | Settled
  | { ok: true; queued: true; writeId: string }
  | { ok: false; code: string; message: string };

export type ProjectManageOwner = Pick<ClientCore, "request" | "enqueue" | "intent" | "commandId">;

export class ProjectManage {
  readonly #owner: ProjectManageOwner;
  readonly #schedule: (delay: number, run: () => void) => () => void;
  readonly #folders: ProjectFolders;
  readonly #repositories: Repositories;
  readonly #scripts: ProjectScripts;
  /** Queued writes' eventual receipts, by write id. */
  readonly #queued = new Map<string, Kept>();
  constructor(owner: ProjectManageOwner, schedule: (delay: number, run: () => void) => () => void) {
    this.#owner = owner;
    this.#schedule = schedule;
    this.#folders = new ProjectFolders(owner, (raw) => this.write(raw));
    this.#repositories = new Repositories(owner, (raw) => this.write(raw));
    this.#scripts = new ProjectScripts(owner, (raw) => this.write(raw));
  }

  /**
   * `signal` is the native request's: a poll the phone stopped waiting on (timed out,
   * cancelled) lets go at once, while the write's receipt stays kept for the next poll.
   */
  async answer(
    request: NativeProjectRequest["request"],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    switch (request.op) {
      case "options":
        return this.#options(request.workspaceId, request.current);
      case "save": {
        const defaults =
          request.draft.defaults === undefined
            ? undefined
            : ProjectDefaults.safeParse(request.draft.defaults);
        if (defaults && !defaults.success)
          return refused("invalid", "A default model needs its agent. Pick the model again.");
        const result = projectEdit(request.project, {
          name: request.draft.name,
          icon: request.draft.icon,
          defaults: defaults?.data,
          notes: request.draft.notes,
        });
        if (result.kind === "invalid") return refused("invalid", result.problem);
        if (result.kind === "unchanged") return { ok: true, queued: false };
        return this.write({
          type: "workspace.update",
          workspaceId: request.project.id,
          ...result.edit,
        });
      }
      case "initials":
        return { ok: true, initials: projectInitials(request.name) };
      case "repos.context":
      case "repos.list":
      case "publish.status":
      case "publish":
      case "publish.cancel":
        return this.#repositories.answer(request);
      case "outcome":
        return this.#outcome(request.writeId, signal);
      case "scripts":
      case "runScript":
      case "previews":
        return this.#scripts.answer(request);
      case "openers":
      case "open":
        return answerHostOpen(this.#owner, request);
      case "roots":
      case "allowFolder":
      case "removeFolder":
        return this.#folders.answer(request);
      case "remove":
        return this.write({
          type: "workspace.remove",
          workspaceId: request.workspaceId,
          stopRunning: request.stopRunning,
        });
    }
  }

  /**
   * Send a project command durably and wait for the daemon's receipt. One that takes longer
   * than `receiptWait` answers `queued` with a `writeId`: the command stays in the outbox and
   * its eventual receipt, taken or refused, is kept for `outcome` to give.
   */
  write(raw: unknown): Promise<WriteOutcome> {
    const payload = CommandPayload.safeParse(raw);
    if (!payload.success)
      return Promise.resolve(refused("invalid", projectProblem("invalid").message));
    let saved: () => void = noop;
    const admitted = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const final = new Promise<Settled>((resolve) => {
      submitCommand(
        this.#owner,
        payload.data,
        () => saved(),
        (result) => {
          if (result.ok)
            resolve({
              ok: true,
              queued: false,
              ...(result.terminalId ? { terminalId: result.terminalId } : {}),
            });
          else {
            const code = result.error ?? "project_failed";
            resolve(refused(code, projectProblem(code).message));
          }
        },
      ).catch(() =>
        resolve(
          refused("unsaved", "Couldn't save that on this phone. Your changes are still here."),
        ),
      );
    });
    return new Promise((resolve) => {
      let done = false;
      let stop: () => void = noop;
      void final.then((outcome) => {
        if (done) return;
        done = true;
        stop();
        resolve(outcome);
      });
      void admitted.then(() => {
        if (done) return;
        stop = this.#schedule(receiptWait, () => {
          if (done) return;
          done = true;
          const writeId = this.#owner.commandId();
          this.#keep(writeId, final);
          resolve({ ok: true, queued: true, writeId });
        });
      });
    });
  }

  /** A queued write's eventual receipt, once; unknown when this run never queued it. */
  #outcome(writeId: string, signal: AbortSignal): Promise<Settled> {
    const kept = this.#queued.get(writeId);
    if (!kept)
      return Promise.resolve(
        refused(
          "unknown",
          "This phone lost track of that change. Check the project on your computer.",
        ),
      );
    if (kept.outcome) {
      this.#queued.delete(writeId);
      return Promise.resolve(kept.outcome);
    }
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      // One waiter per poll, removed however the poll ends: answered, cancelled or timed out.
      const answered = (outcome: Settled) => {
        stop();
        this.#queued.delete(writeId);
        resolve(outcome);
      };
      const abandoned = () => {
        stop();
        reject(signal.reason);
      };
      const stop = () => {
        kept.waiters.delete(answered);
        signal.removeEventListener("abort", abandoned);
      };
      kept.waiters.add(answered);
      signal.addEventListener("abort", abandoned, { once: true });
    });
  }

  /** Polls waiting on a queued write's receipt right now. */
  get waitingPolls(): number {
    let count = 0;
    for (const kept of this.#queued.values()) count += kept.waiters.size;
    return count;
  }

  /** The bridge is going away: forget kept receipts and their waiters; writes stay in the outbox. */
  dispose(): void {
    for (const kept of this.#queued.values()) kept.waiters.clear();
    this.#queued.clear();
  }

  #keep(writeId: string, final: Promise<Settled>): void {
    // Bounded: the oldest kept receipt nobody asked for goes first.
    if (this.#queued.size >= 64) {
      const oldest = this.#queued.keys().next().value;
      if (oldest !== undefined) this.#queued.delete(oldest);
    }
    const kept: Kept = { outcome: undefined, waiters: new Set() };
    this.#queued.set(writeId, kept);
    // The receipt's one reaction: kept for a later poll, and given to whoever waits now.
    void final.then((outcome) => {
      kept.outcome = outcome;
      for (const waiter of kept.waiters) waiter(outcome);
    });
  }

  /** What the project's new threads can default to: models on this machine, local branches. */
  async #options(workspaceId: string, current: Pick<ProjectDefaults, "provider" | "model">) {
    const [models, branches] = await Promise.all([
      this.#models(current).catch(() => undefined),
      this.#owner
        .request(
          { type: "workspace.request", operation: { op: "branches.list", workspaceId } },
          quiet,
        )
        .then((reply) => reply.result)
        .catch(() => undefined),
    ]);
    const names =
      branches?.kind === "branches"
        ? branches.refs
          ? branches.refs.filter((ref) => !ref.remote).map((ref) => ref.name)
          : branches.branches
        : [];
    return {
      ok: true,
      choices,
      models: models ?? [],
      modelsFailed: models === undefined,
      branches: [...new Set(names)].slice(0, 200),
      git: branches?.kind === "branches",
    };
  }

  async #models(current: Pick<ProjectDefaults, "provider" | "model">) {
    const catalog = await readModelCatalog(this.#owner, {}).catch((): ModelCatalog => ({
      models: [],
      instances: [],
    }));
    const readiness = await this.#owner.request(
      { type: "providers.request", operation: "readiness" },
      quiet,
    );
    const statuses = (readiness.result.ok ? readiness.result.providers : [])
      .filter((row) => row.enabled !== false)
      .map((row) => ({
        provider: row.provider,
        state: row.installed === false ? ("not_installed" as const) : ("ready" as const),
      }));
    // Accounts only order a model's rows; every listed model is offered once.
    const options = newThreadOptions(catalog.models, [], statuses);
    return projectDefaultModels(options.models, current)
      .slice(0, 400)
      .map((model) =>
        Object.assign(model, { label: `${model.label} · ${providerNames[model.provider]}` }),
      );
  }
}

const noop = () => {};
const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** The editor's fixed choices, in the web's words and order. */
const choices = {
  access: accessModes.map((mode) => ({
    id: mode,
    label: accessLabel(mode),
    note: accessDescription(mode),
  })),
  browserProfiles: projectBrowserProfiles.map((profile) => ({
    id: profile.value ?? null,
    label: profile.label,
    note: profile.note,
  })),
  glyphs: ProjectGlyph.options.map((glyph) => ({
    id: glyph,
    icon: projectGlyphIcons[glyph],
    label: capital(glyph),
  })),
  colours: BadgeColor.options.map((colour) => ({ id: colour, label: capital(colour) })),
};

function refused(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}
