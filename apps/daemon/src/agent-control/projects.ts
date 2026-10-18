import { basename } from "node:path";
import { decodeProjectRow, projectSelect } from "../project-storage.ts";
import type { Store } from "../store.ts";

export interface ProjectChoice {
  id: string;
  name: string;
  path: string;
  /** The caller's own project. */
  current?: true;
}
export type ProjectLookup =
  | { ok: true; project: ProjectChoice }
  | { ok: false; code: "not_found" | "invalid"; hint: string };

/** Registered projects on this machine, most recently opened first. */
function registered(store: Store): ProjectChoice[] {
  return store.atomic((db) =>
    db
      .prepare(
        `${projectSelect} LEFT JOIN workspace_recent r ON r.workspace_id=w.id
        WHERE NOT EXISTS (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)
        ORDER BY r.opened_at IS NULL, r.opened_at DESC, w.name`,
      )
      .all()
      .map(decodeProjectRow)
      .map(({ id, name, path }) => ({ id, name, path })),
  );
}

/** Projects whose name or folder contains every word of the query; `current` is marked. */
export function findProjects(
  store: Store,
  query: string,
  limit: number,
  current?: string,
): ProjectChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = registered(store)
    .filter((project) => {
      const text = `${project.name} ${project.path}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, limit);
  const own = found.find((project) => project.id === current);
  if (own) own.current = true;
  return found;
}

/**
 * The one project a reference names: its id, its folder path, or its name or folder name
 * (case-insensitive). Two projects sharing a name are ambiguous; the hint lists them.
 */
export function resolveProject(store: Store, reference: string): ProjectLookup {
  const projects = registered(store);
  const wanted = reference.trim().replace(/\/+$/, "");
  const exact = projects.find((project) => project.id === wanted || project.path === wanted);
  if (exact) return { ok: true, project: exact };
  const lower = wanted.toLowerCase();
  const named = projects.filter(
    (project) =>
      project.name.toLowerCase() === lower || basename(project.path).toLowerCase() === lower,
  );
  if (named.length === 1 && named[0]) return { ok: true, project: named[0] };
  if (named.length > 1)
    return {
      ok: false,
      code: "invalid",
      hint: `More than one project is named ${wanted}: ${named
        .slice(0, 5)
        .map((project) => project.path)
        .join(", ")}. Pass its path or id.`,
    };
  return {
    ok: false,
    code: "not_found",
    hint: `No project named ${wanted} is open in ace. projects_find lists them; the person adds new ones.`,
  };
}
