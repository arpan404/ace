import type { CatalogModel, ProviderKind } from "@ace/protocol";
import { catalogModelIds, modelKey, modelLabel } from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * The open thread's model sheet rows: the models its provider and account list (`models.list`),
 * each once, the one it runs on marked (its account's default when it names none). The thread's model always shows and stays marked, listed
 * first under its own name when the catalog doesn't carry it (a retired or custom model).
 * `favorites` are this provider's starred models among them, in the order they were starred.
 */

export interface ThreadModelRow {
  id: string;
  label: string;
  detail: string;
  current: boolean;
}

export function threadModelRows(
  listed: readonly CatalogModel[],
  selection: { provider: ProviderKind; model?: string | undefined },
  stars: readonly string[],
  preview: Preview,
): { models: ThreadModelRow[]; favorites: string[] } {
  const canonical = catalogModelIds(listed);
  // A thread that names no model runs its account's default.
  const running = selection.model
    ? canonical(selection.provider, selection.model)
    : (listed.find((model) => model.isDefault)?.id ?? null);
  const seen = new Set<string>();
  const models = listed.flatMap((model) => {
    if (seen.has(model.id)) return [];
    seen.add(model.id);
    return [
      {
        id: model.id,
        label: preview(model.displayName || modelLabel(model.id), 128),
        detail: preview(model.detail ?? "", 256),
        current: model.id === running,
      },
    ];
  });
  if (selection.model && !models.some((row) => row.current))
    models.unshift({
      id: selection.model,
      label: preview(modelLabel(selection.model), 128),
      detail: "",
      current: true,
    });
  const ids = new Set(models.map((row) => row.id));
  const favorites = [
    ...new Set(
      stars.flatMap((key) => {
        const id = key.startsWith(modelKey(selection.provider, ""))
          ? key.slice(selection.provider.length + 1)
          : undefined;
        return id && ids.has(id) ? [id] : [];
      }),
    ),
  ];
  return { models, favorites };
}
