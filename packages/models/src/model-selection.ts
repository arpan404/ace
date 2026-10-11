import type { CatalogModel } from "@ace/protocol";

export function isDefaultSelection(id: string | undefined): boolean {
  return id !== undefined && /^(?:default(?:\s*\(recommended\))?)$/i.test(id.trim());
}

export function matchesModel(row: CatalogModel, id: string): boolean {
  return (
    row.id === id ||
    row.nativeModelId === id ||
    row.resolvedModelId === id ||
    row.aliases?.includes(id) === true ||
    (row.provider === "opencode" &&
      !id.includes("/") &&
      row.id.slice(row.id.indexOf("/") + 1) === id)
  );
}
