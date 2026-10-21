import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { readJson, writeJson } from "@ace/ui-core";
import { useLayout } from "@/lib/layout.tsx";
import { useRegisteredProjects } from "@/lib/projects.ts";
import { defaultFilters, ForgeFilters, listProject } from "./filters.ts";

const storageKey = "ace.forge.filters";

interface ForgeBrowse {
  /** The project both lists read; undefined while projects load or when there are none. */
  project: string | undefined;
  projects: readonly string[];
  projectsLoaded: boolean;
  projectName(id: string): string;
  filters: ForgeFilters;
  change(patch: Partial<ForgeFilters>): void;
  /** Each list's search text, kept while moving between a list and its items. */
  search: { pulls: string; issues: string };
  setSearch(kind: "pulls" | "issues", text: string): void;
}

const Context = createContext<ForgeBrowse | null>(null);

/**
 * The Pull requests view's choices, shared by its sidebar list and its pages: the project, the
 * filters (kept on this device) and the search text (kept until the view closes).
 */
export function ForgeBrowseProvider(props: { children: ReactNode }) {
  const { storage } = useLayout();
  const { ids, name, loaded } = useRegisteredProjects();
  const routed = useParams({ strict: false, select: (params) => params.project });
  const [filters, setFilters] = useState(() =>
    readJson(storage, storageKey, ForgeFilters, defaultFilters),
  );
  const [search, setSearchState] = useState({ pulls: "", issues: "" });
  const project = listProject(routed, filters.project, ids);
  const value = useMemo<ForgeBrowse>(
    () => ({
      project,
      projects: ids,
      projectsLoaded: loaded,
      projectName: name,
      filters,
      change(patch) {
        setFilters((current) => {
          const next = { ...current, ...patch };
          writeJson(storage, storageKey, next);
          return next;
        });
      },
      search,
      setSearch: (kind, text) => setSearchState((current) => ({ ...current, [kind]: text })),
    }),
    [project, ids, loaded, name, filters, search, storage],
  );
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useForgeBrowse(): ForgeBrowse {
  const value = useContext(Context);
  if (!value) throw new Error("useForgeBrowse needs ForgeBrowseProvider");
  return value;
}
