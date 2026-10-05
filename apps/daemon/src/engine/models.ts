import { isDefaultSelection, selectionModelFilter, type ModelCatalogApi } from "@ace/models";
import {
  AcpIdentity,
  type ExecutionSelection,
  type ProviderKind,
  type ThreadId,
} from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

export class ModelSelectionError extends Error {
  constructor() {
    super("model_unavailable");
  }
}

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
  select(
    provider: ProviderKind,
    model?: string,
    instance?: string,
    identity?: AcpIdentity,
  ): string | undefined {
    if (!this.catalog) return isDefaultSelection(model) ? undefined : model;
    const filter = selectionModelFilter(provider, instance, identity);
    if (!filter) {
      if (model && !isDefaultSelection(model)) throw new ModelSelectionError();
      return undefined;
    }
    const resolution = this.catalog.resolve({
      role: "thread",
      ...filter,
      ...(model && !isDefaultSelection(model) ? { model } : {}),
    });
    if (!resolution.ok) {
      if (model && !isDefaultSelection(model)) throw new ModelSelectionError();
      return undefined;
    }
    const chosen = resolution.model;
    return chosen.nativeProviderId
      ? `${chosen.nativeProviderId}/${chosen.nativeModelId}`
      : chosen.nativeModelId;
  }
  identity(id: ThreadId): AcpIdentity | undefined {
    const thread = this.repo.store.getThread(id);
    return thread?.provider === "acp" ? AcpIdentity.parse(thread) : undefined;
  }
  async prepare(
    selection: ExecutionSelection,
    identity?: AcpIdentity,
  ): Promise<ExecutionSelection> {
    const defaultRequested = !selection.model || isDefaultSelection(selection.model);
    const filter = selectionModelFilter(selection.provider, selection.instanceId, identity);
    if (
      defaultRequested &&
      this.catalog &&
      filter &&
      !this.select(selection.provider, undefined, selection.instanceId, identity)
    ) {
      await this.catalog.refresh(filter);
    }
    const model = this.select(selection.provider, selection.model, selection.instanceId, identity);
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
  migrateCachedDefaults(): void {
    const catalog = this.catalog;
    if (!catalog?.resolveCached) return;
    for (const state of this.repo.states()) {
      const metadata = this.repo.session(state.threadId);
      const selection = this.repo.transitions.get(state.threadId).selection;
      if (!isDefaultSelection(metadata.model) && !isDefaultSelection(selection?.model)) continue;
      const previous = selection ?? { provider: state.config.provider, options: {}, ...metadata };
      // Startup only uses already-known choices. Discovery belongs to session opening.
      const filter = selectionModelFilter(
        previous.provider,
        previous.instanceId,
        this.identity(state.threadId),
      );
      if (!filter) continue;
      const resolution = catalog.resolveCached({
        role: "thread",
        ...filter,
        ...(previous.model && !isDefaultSelection(previous.model) ? { model: previous.model } : {}),
      });
      const chosen = resolution.ok ? resolution.model : undefined;
      const model = chosen?.nativeProviderId
        ? `${chosen.nativeProviderId}/${chosen.nativeModelId}`
        : chosen?.nativeModelId;
      // With no cached choice, restore an implicit selection. Resume discovers it later.
      const { model: _oldModel, ...rest } = previous;
      const next = { ...rest, ...(model ? { model } : {}) };
      if (model !== metadata.model || model !== selection?.model)
        this.remember(state.threadId, next);
    }
  }
}
