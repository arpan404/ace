import { isDefaultSelection, type ModelCatalogApi } from "@ace/models";
import type { ExecutionSelection, ProviderKind, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/** One selection boundary for creation, resume, switches and legacy controls. */
export class EngineModels {
  private catalog: ModelCatalogApi | undefined;
  private repo: EngineRepository;
  private now: () => number;
  constructor(repo: EngineRepository, now: () => number, catalog?: ModelCatalogApi) {
    this.repo = repo;
    this.now = now;
    this.catalog = catalog;
  }
  select(provider: ProviderKind, model?: string, instance?: string): string | undefined {
    if (!this.catalog) return isDefaultSelection(model) ? undefined : model;
    const selectedInstance = this.instance(provider, instance);
    const resolution = this.catalog.resolve({
      role: "thread",
      provider,
      ...(selectedInstance ? { instance: selectedInstance } : {}),
      ...(model && !isDefaultSelection(model) ? { model } : {}),
    });
    if (!resolution.ok) return isDefaultSelection(model) ? undefined : model;
    const chosen = resolution.model;
    return chosen.nativeProviderId
      ? `${chosen.nativeProviderId}/${chosen.nativeModelId}`
      : chosen.nativeModelId;
  }
  private instance(provider: ProviderKind, instance?: string): string | undefined {
    if (instance) return instance;
    const native = `${provider}-cli-default`;
    return this.catalog
      ?.list({ provider, limit: 1 })
      .instances.some((row) => row.instance === native)
      ? native
      : undefined;
  }
  async prepare(selection: ExecutionSelection): Promise<ExecutionSelection> {
    const defaultRequested = !selection.model || isDefaultSelection(selection.model);
    if (
      defaultRequested &&
      this.catalog &&
      !this.select(selection.provider, undefined, selection.instanceId)
    ) {
      const instance = this.instance(selection.provider, selection.instanceId);
      await this.catalog.refresh({
        provider: selection.provider,
        ...(instance ? { instance } : {}),
      });
    }
    const model = this.select(selection.provider, selection.model, selection.instanceId);
    const { model: _previous, ...rest } = selection;
    const next = { ...rest, ...(model ? { model } : {}) };
    return next;
  }
  remember(id: ThreadId, selection: ExecutionSelection): void {
    this.repo.store.atomic((db) => {
      const previous = this.repo.transitions.get(id);
      const oldModels = [this.repo.session(id).model, previous.selection?.model];
      for (const oldModel of new Set(oldModels)) {
        if (isDefaultSelection(oldModel))
          db.prepare(
            "DELETE FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?",
          ).run(id, selection.provider, oldModel ?? "");
      }
      db.prepare("UPDATE engine_sessions SET model=? WHERE thread_id=?").run(
        selection.model ?? null,
        id,
      );
      this.repo.transitions.set(id, { ...previous, selection });
      this.repo.transitions.remember(id, selection);
      const state = this.repo.requireState(id);
      if (selection.model)
        this.repo.apply(
          id,
          [{ type: "agent.linked", agent: state.rootKey ?? "root", model: selection.model }],
          this.now(),
        );
      this.repo.store.appendEvents(
        id,
        [{ type: "thread.updated", execution: selection }],
        this.now(),
      );
    });
  }
  async migrateDefaults(): Promise<void> {
    const attempted = new Set<string>();
    for (const state of this.repo.states()) {
      const metadata = this.repo.session(state.threadId);
      const selection = this.repo.transitions.get(state.threadId).selection;
      if (!isDefaultSelection(metadata.model) && !isDefaultSelection(selection?.model)) continue;
      const previous = selection ?? { provider: state.config.provider, options: {}, ...metadata };
      const key = JSON.stringify([previous.provider, previous.instanceId]);
      if (
        !this.select(previous.provider, previous.model, previous.instanceId) &&
        attempted.has(key)
      )
        continue;
      attempted.add(key);
      const next = await this.prepare(previous);
      if (next.model && (next.model !== metadata.model || next.model !== selection?.model))
        this.remember(state.threadId, next);
    }
  }
}
