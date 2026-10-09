import { matchesModel } from "@ace/models/resolve";
import type { CatalogModel, ProviderKind } from "@ace/protocol";

/*
 * The ids a catalog row goes by, apart from the pickers' joins in `models.ts`: a thread's
 * composer asks what its model reads without loading those.
 */

/** Ids other than the catalog id that name the row: native, resolved and alias ids. */
export function modelAliases(model: CatalogModel): string[] {
  const ids = [
    model.nativeModelId,
    model.resolvedModelId,
    ...(model.aliases ?? []),
    ...(model.provider === "opencode" ? [model.id.slice(model.id.indexOf("/") + 1)] : []),
  ];
  return [...new Set(ids.filter((id): id is string => id !== undefined && id !== model.id))];
}

/**
 * What the catalog says a thread's model reads (its input modalities: "text", "image"…), by the
 * same ids a choice is matched by; undefined when the selection names no model the catalog lists.
 */
export function selectionInputs(
  models: readonly CatalogModel[],
  selection: { provider: ProviderKind; model?: string | undefined } | undefined,
): readonly string[] | undefined {
  const named = selection?.model;
  if (!named) return undefined;
  return models.find((model) => model.provider === selection.provider && matchesModel(model, named))
    ?.inputModalities;
}

/** Canonical identities for historical rows, including unambiguous bare OpenCode selectors. */
export function catalogModelIds(models: readonly CatalogModel[]) {
  const ids = new Map<string, string | null>();
  for (const model of models) {
    const aliases = [model.id, ...modelAliases(model)];
    for (const alias of aliases) {
      const key = `${model.provider}\0${alias}`;
      const previous = ids.get(key);
      ids.set(key, previous === undefined || previous === model.id ? model.id : null);
    }
  }
  return (provider: string, id: string | null | undefined) =>
    id ? (ids.get(`${provider}\0${id}`) ?? id) : null;
}
