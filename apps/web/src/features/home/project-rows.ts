import type { HomeRow } from "@ace/ui-core";

/** Group each unpinned section by first project occurrence; retain priority within a project. */
export function groupProjectRows(
  rows: readonly HomeRow[],
  projects: Readonly<Record<string, string>>,
): HomeRow[] {
  const result: HomeRow[] = [];
  let groups = new Map<string, HomeRow[]>();
  let section: HomeRow["kind"] | undefined;
  const flush = () => {
    for (const group of groups.values()) result.push(...group);
    groups = new Map();
  };
  for (const row of rows) {
    if (row.kind !== section) flush();
    section = row.kind;
    if (row.kind === "thread" || row.kind === "settled") {
      const project = projects[row.id] ?? "";
      const group = groups.get(project);
      if (group) group.push(row);
      else groups.set(project, [row]);
    } else result.push(row);
  }
  flush();
  return result;
}

/** Headings follow the drawn order, including while motion and focus hold rows in place. */
export function startsProject(
  row: HomeRow,
  previous: HomeRow | undefined,
  projects: Readonly<Record<string, string>>,
): boolean {
  if (!("id" in row)) return false;
  return (
    !previous ||
    !("id" in previous) ||
    previous.kind !== row.kind ||
    projects[row.id] !== projects[previous.id]
  );
}
