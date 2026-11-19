import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

/*
 * Which projects Code review's lists (Inbox, Pull requests, Issues) show: every project unless
 * the person picks some. The choice lives in each list's address (`?projects=[…]`) and is
 * remembered on this device, so it holds across the three lists and across reloads. Pure rules
 * here; `useProjectChoice` (forge-pages) reads and writes it.
 */

const key = "ace.forge.projects";
const Remembered = z.array(z.string().min(1).max(512)).max(200);

/** The projects last picked on this device; empty is every project. */
export function rememberedProjects(storage: KeyValueStorage | undefined): string[] {
  return readJson(storage, key, Remembered, []);
}

export function rememberProjects(
  storage: KeyValueStorage | undefined,
  picked: readonly string[],
): void {
  writeJson(storage, key, [...picked]);
}

/** What a list's address says about projects: `projects`, or an older link's single `project`. */
export interface ProjectsSearch {
  projects?: string[] | undefined;
  project?: string | undefined;
}

/**
 * The projects picked, as the list should read them: the address's choice, else the one
 * remembered; only projects that still exist, in the projects' own order. Empty is every
 * project, and so is a pick that names all of them.
 */
export function pickedProjects(
  search: ProjectsSearch,
  remembered: readonly string[],
  all: readonly string[],
): string[] {
  const asked = search.projects ?? (search.project ? [search.project] : remembered);
  const wanted = new Set(asked);
  const picked = all.filter((id) => wanted.has(id));
  return picked.length === all.length ? [] : picked;
}

/** The projects a list reads: the picked ones, or every project when none is picked. */
export function readProjects(picked: readonly string[], all: readonly string[]): string[] {
  return picked.length ? [...picked] : [...all];
}

/** Tick or untick one project. Unticking the last, or ticking the last missing, is every project. */
export function toggleProject(
  picked: readonly string[],
  id: string,
  all: readonly string[],
): string[] {
  const next = new Set(picked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  const ordered = all.filter((project) => next.has(project));
  return ordered.length === all.length ? [] : ordered;
}

/** The menu's label: "All projects", one name, two names, then "N projects". */
export function projectsLabel(picked: readonly string[], name: (id: string) => string): string {
  if (!picked.length) return "All projects";
  if (picked.length <= 2) return picked.map(name).join(", ");
  return `${picked.length} projects`;
}

/** The address's part for a pick: nothing for every project. */
export function projectsParam(picked: readonly string[]): string[] | undefined {
  return picked.length ? [...picked] : undefined;
}
