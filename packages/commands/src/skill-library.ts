import { SkillOperation, type SkillAgent, type SkillResult, type SkillUsage } from "@ace/protocol";
import { CommandCatalog } from "./catalog.ts";
import { CommandFiles, type WatchSource } from "./files.ts";
import type { RecoveryScheduler } from "./recovery-loop.ts";
import type { DiscoveryRoot } from "./roots.ts";
import { editSkill, newSkill } from "./skill-markdown.ts";
import {
  createSkillDirectory,
  linkSkill,
  readSkillFile,
  removeSkillDirectory,
  replaceSkillFile,
  SkillError,
  unlinkSkill,
  writableDirectory,
} from "./skill-files.ts";
import { planAgents } from "./skill-model.ts";
import { canonicalRoot, skillRoots, type SkillHomes } from "./skill-roots.ts";
import { SkillUpdates, type SkillUpdateOptions } from "./skill-updates.ts";
import { rm } from "node:fs/promises";
import { listSkills, type Listed, type PluginSkill } from "./skill-listing.ts";
export type { PluginSkill } from "./skill-listing.ts";

export type SkillUsageReader = (
  names: readonly string[],
) => Promise<ReadonlyMap<string, Omit<SkillUsage, "id">>>;
export interface SkillLibraryOptions {
  homes: SkillHomes;
  workspace(workspaceId: string): string | undefined;
  /** ace's shipped skills (`@ace/plugins` builtin-skills). */
  builtinDirectory?: string | undefined;
  pluginSkills?: (() => Promise<readonly PluginSkill[]>) | undefined;
  updates?: SkillUpdateOptions | undefined;
  usage?: SkillUsageReader | undefined;
  watch?: WatchSource | undefined;
  schedule?: RecoveryScheduler | undefined;
  id(): string;
}
const watchedRoot = (path: string, scope: "user" | "workspace", home: string): DiscoveryRoot => ({
  path,
  format: "claude",
  scope,
  skill: true,
  skillLinkHome: home,
});
/** Native skills across every agent's folders: one entry per skill directory (ADR 0103). */
export class SkillLibrary {
  private readonly options: SkillLibraryOptions;
  private readonly updates: SkillUpdates | undefined;
  private readonly watchers = new Map<string, { files: CommandFiles; users: number }>();
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  constructor(options: SkillLibraryOptions) {
    this.options = options;
    this.updates = options.updates ? new SkillUpdates(options.updates) : undefined;
  }
  /** Self-heal after a crash mid-update, before the first request. */
  async start(): Promise<void> {
    await this.updates?.recover(skillRoots(this.options.homes).map((root) => root.path));
  }
  request(operation: unknown): Promise<SkillResult> {
    const parsed = SkillOperation.safeParse(operation);
    if (!parsed.success)
      return Promise.resolve({ kind: "error", code: "invalid", message: "Choose a valid skill." });
    if (this.closed || this.pending >= 16)
      return Promise.resolve({
        kind: "error",
        code: "unavailable",
        message: "Skills are busy. Try again in a moment.",
      });
    this.pending++;
    const result = this.tail
      .then(() => this.perform(parsed.data))
      .catch((error: unknown): SkillResult => {
        if (error instanceof SkillError)
          return { kind: "error", code: error.code, message: error.message };
        if (error instanceof Error && error.message === "invalid_frontmatter")
          return {
            kind: "error",
            code: "invalid",
            message: "This skill's frontmatter isn't valid YAML. Fix it in an editor first.",
          };
        return {
          kind: "error",
          code: "unavailable",
          message: "Couldn't change this skill. Try again.",
        };
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = result;
    return result;
  }
  /** Changes from disk or from this library. Watches personal roots and, if named, the project's. */
  subscribe(workspaceId: string | undefined, listener: () => void): () => void {
    if (this.closed || this.listeners.size >= 64) throw new Error("Skill subscription limit");
    const keys = ["", ...(workspaceId ? [this.workspace(workspaceId)] : [])];
    for (const key of keys) this.watch(key);
    const wrapped = () => listener();
    this.listeners.add(wrapped);
    return () => {
      this.listeners.delete(wrapped);
      for (const key of keys) this.unwatch(key);
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.tail.catch(() => {});
    for (const { files } of this.watchers.values()) await files.close();
    this.watchers.clear();
    await this.updates?.close();
  }
  /** Sources outside the watched folders changed, such as installed plugins. */
  invalidate(): void {
    this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* One closed connection cannot stop the others. */
      }
    }
  }
  private watch(workspace: string): void {
    const held = this.watchers.get(workspace);
    if (held) {
      held.users++;
      return;
    }
    if (this.watchers.size >= 9) throw new Error("Skill watch limit");
    const home = this.options.homes.home;
    const roots = skillRoots(this.options.homes, workspace || undefined)
      .filter((root) => (workspace ? root.scope === "project" : root.scope === "personal"))
      .map((root) => watchedRoot(root.path, workspace ? "workspace" : "user", home));
    const files = new CommandFiles(new CommandCatalog(() => 0), roots, {
      ...(this.options.watch ? { watch: this.options.watch } : {}),
      ...(this.options.schedule ? { schedule: this.options.schedule } : {}),
    });
    files.subscribe(() => this.notify());
    void files.start().catch(() => {});
    this.watchers.set(workspace, { files, users: 1 });
  }
  private unwatch(workspace: string): void {
    const held = this.watchers.get(workspace);
    if (!held || --held.users > 0) return;
    this.watchers.delete(workspace);
    void held.files.close();
  }
  private workspace(workspaceId: string): string {
    const path = this.options.workspace(workspaceId);
    if (!path) throw new SkillError("not_found", "This project isn't on this machine.");
    return path;
  }
  private listAll(workspaceId: string | undefined): Promise<Listed[]> {
    return listSkills({
      ...this.options,
      workspace: workspaceId ? this.workspace(workspaceId) : undefined,
      locked: this.updates?.locked(),
    });
  }
  private async find(id: string, workspaceId: string | undefined): Promise<Listed> {
    const found = (await this.listAll(workspaceId)).find((listed) => listed.entry.id === id);
    if (!found) throw new SkillError("not_found", "This skill no longer exists. Reload the list.");
    return found;
  }
  private async editable(id: string, workspaceId: string | undefined) {
    const found = await this.find(id, workspaceId);
    const canonical = found.place.canonical;
    if (!found.entry.editable || !canonical)
      throw new SkillError(
        "read_only",
        "Skills built into ace, from plugins or outside agent folders can't be changed here.",
      );
    return { ...found, canonical };
  }
  private async skill(
    id: string,
    workspaceId: string | undefined,
    kept?: Extract<SkillResult, { kind: "skill" }>["kept"],
  ): Promise<SkillResult> {
    const found = await this.find(id, workspaceId);
    if (found.text === undefined)
      throw new SkillError("read_only", "Open the plugin to read this skill's instructions.");
    return {
      kind: "skill",
      entry: found.entry,
      text: found.text,
      ...(kept?.length ? { kept } : {}),
    };
  }
  private async setAgents(
    id: string,
    workspaceId: string | undefined,
    agents: readonly SkillAgent[],
  ) {
    const { place, canonical } = await this.editable(id, workspaceId);
    const workspace = workspaceId ? this.workspace(workspaceId) : undefined;
    const plan = planAgents(place, skillRoots(this.options.homes, workspace), agents);
    for (const link of plan.remove) await unlinkSkill(link);
    for (const root of plan.add) await linkSkill(root, place.name, canonical);
    return plan.kept;
  }
  private async perform(op: SkillOperation): Promise<SkillResult> {
    switch (op.op) {
      case "list":
        return {
          kind: "list",
          entries: (await this.listAll(op.workspaceId)).map((l) => l.entry),
          stale: false,
        };
      case "read":
        return this.skill(op.id, op.workspaceId);
      case "create": {
        const workspaceId = op.scope.kind === "project" ? op.scope.workspaceId : undefined;
        const existing = await this.listAll(workspaceId);
        if (
          existing.some(
            (l) =>
              l.place.scope === op.scope.kind &&
              l.place.name === op.name &&
              l.entry.scope !== "builtin" &&
              l.entry.scope !== "plugin",
          )
        )
          throw new SkillError("exists", `You already have a skill called ${op.name}.`);
        const workspace = workspaceId ? this.workspace(workspaceId) : undefined;
        const root = canonicalRoot(skillRoots(this.options.homes, workspace), op.scope.kind);
        const directory = await createSkillDirectory(root, op.name);
        try {
          await replaceSkillFile(
            directory,
            newSkill(op.name, op.description, op.body, op.manual),
            null,
            this.options.id(),
          );
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
        const created = (await this.listAll(workspaceId)).find(
          (l) => l.place.canonical?.real === directory,
        );
        if (!created) throw new SkillError("unavailable", "The new skill couldn't be read back.");
        await this.setAgents(created.entry.id, workspaceId, op.agents);
        this.notify();
        return this.skill(created.entry.id, workspaceId);
      }
      case "edit": {
        const { canonical, text } = await this.editable(op.id, op.workspaceId);
        const directory = await writableDirectory(canonical);
        if (text === undefined || (await readSkillFile(directory)).hash !== op.expectedHash)
          throw new SkillError(
            "conflict",
            "This skill changed elsewhere. Reload it before saving.",
          );
        const next = editSkill(text, op);
        await replaceSkillFile(directory, next, op.expectedHash, this.options.id());
        this.notify();
        return this.skill(op.id, op.workspaceId);
      }
      case "setAgents": {
        const kept = await this.setAgents(op.id, op.workspaceId, op.agents);
        this.notify();
        return this.skill(op.id, op.workspaceId, kept);
      }
      case "delete": {
        const { place, canonical } = await this.editable(op.id, op.workspaceId);
        if ((await readSkillFile(await writableDirectory(canonical))).hash !== op.expectedHash)
          throw new SkillError(
            "conflict",
            "This skill changed elsewhere. Reload it before deleting.",
          );
        for (const link of place.members.filter((m) => m.link)) await unlinkSkill(link);
        await removeSkillDirectory(canonical);
        this.notify();
        return { kind: "deleted", id: op.id };
      }
      case "checkUpdate": {
        const { entry, place } = await this.withSource(op.id, op.workspaceId);
        const status = await this.requireUpdates().check(place.name);
        return { kind: "updateStatus", id: entry.id, ...status };
      }
      case "prepareUpdate": {
        const { entry, canonical } = await this.withSource(op.id, op.workspaceId);
        return {
          kind: "updateReview",
          review: await this.requireUpdates().prepare(entry.id, canonical),
        };
      }
      case "applyUpdate": {
        const { entry, canonical } = await this.withSource(op.id, op.workspaceId);
        await this.requireUpdates().apply(op.reviewId, entry.id, canonical, op.expectedHash);
        this.notify();
        return this.skill(op.id, op.workspaceId);
      }
      case "cancelUpdate":
        await this.updates?.cancel(op.reviewId);
        return { kind: "cancelled", reviewId: op.reviewId };
      case "usage": {
        const listed = (await this.listAll(op.workspaceId)).filter((l) =>
          op.ids.includes(l.entry.id),
        );
        const counts = (await this.options.usage?.(listed.map((l) => l.entry.name))) ?? new Map();
        return {
          kind: "usage",
          usage: listed.map((l) =>
            Object.assign({ id: l.entry.id, count: 0 }, counts.get(l.entry.name)),
          ),
        };
      }
    }
  }
  private requireUpdates(): SkillUpdates {
    if (!this.updates) throw new SkillError("unavailable", "Skill updates aren't available here.");
    return this.updates;
  }
  private async withSource(id: string, workspaceId: string | undefined) {
    const found = await this.editable(id, workspaceId);
    if (!found.entry.source)
      throw new SkillError("invalid", "This skill wasn't installed from a source.");
    return found;
  }
}
