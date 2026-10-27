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
  ]),
});
export type NativeProjectRequest = z.infer<typeof NativeProjectRequest>;

/** How a write ended: taken (or saved here, `queued`), else the daemon's code and words. */
export type WriteOutcome =
  | { ok: true; queued: boolean }
  | { ok: false; code: string; message: string };

export type ProjectManageOwner = Pick<ClientCore, "request" | "enqueue" | "intent" | "commandId">;

export class ProjectManage {
  readonly #owner: ProjectManageOwner;
  readonly #schedule: (delay: number, run: () => void) => () => void;
  constructor(owner: ProjectManageOwner, schedule: (delay: number, run: () => void) => () => void) {
    this.#owner = owner;
    this.#schedule = schedule;
  }

  async answer(request: NativeProjectRequest["request"]): Promise<unknown> {
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
      case "remove":
        return this.write({
          type: "workspace.remove",
          workspaceId: request.workspaceId,
          stopRunning: request.stopRunning,
        });
    }
  }

  /** Send a project command durably and wait for the daemon's receipt, or for `receiptWait`. */
  write(raw: unknown): Promise<WriteOutcome> {
    const payload = CommandPayload.safeParse(raw);
    if (!payload.success)
      return Promise.resolve(refused("invalid", projectProblem("invalid").message));
    return new Promise((resolve) => {
      let done = false;
      let stop = () => {};
      const finish = (outcome: WriteOutcome) => {
        if (done) return;
        done = true;
        stop();
        resolve(outcome);
      };
      submitCommand(
        this.#owner,
        payload.data,
        () => {
          stop = this.#schedule(receiptWait, () => finish({ ok: true, queued: true }));
        },
        (result) => {
          if (result.ok) finish({ ok: true, queued: false });
          else {
            const code = result.error ?? "project_failed";
            finish(refused(code, projectProblem(code).message));
          }
        },
      ).catch(() =>
        finish(
          refused("unsaved", "Couldn't save that on this phone. Your changes are still here."),
        ),
      );
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
      .map((model) => ({ ...model, label: `${model.label} · ${providerNames[model.provider]}` }));
  }
}

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

function refused(code: string, message: string): WriteOutcome {
  return { ok: false, code, message };
}
