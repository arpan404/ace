import { useClient, useConnectionState } from "@ace/client-react";
import { ProviderKind, WorkspaceId, type CatalogEntry } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import { Select } from "@/components/ui/select.tsx";
import { watchCatalog } from "@/lib/catalog.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useStartingProvider } from "@/lib/provider-statuses.ts";
import type { Skill } from "./skills-model.ts";

interface Discovery {
  entries: readonly CatalogEntry[];
  controls: ReactNode;
  pending: boolean;
  failed: boolean;
  retry(): void;
}
const DiscoveryContext = createContext<Discovery>({
  entries: [],
  controls: null,
  pending: false,
  failed: false,
  retry: () => {},
});
export const useSkillDiscovery = () => useContext(DiscoveryContext);

/** Skills uses the same project and provider discovery as a thread's slash menu. */
export function SkillsCatalogProvider({ children }: { children: ReactNode }) {
  const client = useClient();
  const connection = useConnectionState();
  const directory = useProjectDirectory();
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState("");
  const project = directory.projects.find((p) => p.id === selected) ?? directory.projects[0];
  const starting = useStartingProvider();
  const [selectedProvider, setProvider] = useState<ProviderKind>();
  const provider = selectedProvider ?? starting.provider ?? "codex";
  const providerReady = selectedProvider !== undefined || starting.loaded;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    entries: readonly CatalogEntry[];
    failed: boolean;
  }>();
  const projectId = project?.id;
  const key = `${projectId ?? ""}:${provider}:${revision}`;
  useEffect(() => {
    if (!projectId || !providerReady || connection !== "ready") return;
    return watchCatalog(
      client,
      { workspace: { workspaceId: WorkspaceId.parse(projectId), provider } },
      (entries) => setSnapshot({ key, entries, failed: false }),
      () => setSnapshot({ key, entries: [], failed: true }),
    );
  }, [client, connection, projectId, provider, key, providerReady]);
  const current = snapshot?.key === key ? snapshot : undefined;
  const controls = useMemo(
    () =>
      project ? (
        <div className="mb-2 flex gap-2">
          <Select
            label="Skills project"
            value={project.id}
            options={directory.projects.map((p) => ({ value: p.id, label: p.name }))}
            onValueChange={setSelected}
            className="min-w-0 flex-1"
          />
          <Select<ProviderKind>
            label="Skills provider"
            value={provider}
            options={ProviderKind.options.map((value) => ({ value, label: providerNames[value] }))}
            onValueChange={setProvider}
            className="min-w-0 flex-1"
          />
        </div>
      ) : null,
    [project, directory.projects, provider],
  );
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const value = useMemo(
    () => ({
      entries: current?.entries ?? [],
      controls,
      pending: !directory.loaded || Boolean(project && !current),
      failed: current?.failed ?? false,
      retry,
    }),
    [current, controls, directory.loaded, project, retry],
  );
  return <DiscoveryContext value={value}>{children}</DiscoveryContext>;
}

/** Portable plugins retain their editing controls; native entries are read-only discoveries. */
export function withDiscoveredSkills(
  skills: readonly Skill[],
  entries: readonly CatalogEntry[],
): Skill[] {
  const result = [...skills];
  const ids = new Set(skills.map((s) => s.id));
  const portablePlugins = new Set(skills.filter((s) => s.kind === "plugin").map((s) => s.plugin));
  for (const entry of entries) {
    if (entry.kind === "builtin") continue;
    if (
      entry.source.plugin &&
      portablePlugins.has(entry.source.plugin) &&
      skills.some(
        (skill) =>
          skill.plugin === entry.source.plugin &&
          skill.kind === entry.kind &&
          (skill.name === entry.name || skill.name === entry.name.split(":").at(-1)),
      )
    )
      continue;
    const kind = entry.kind;
    const id = `discovered~${entry.id}`;
    if (ids.has(id)) continue;
    result.push({
      id,
      kind,
      name: entry.name,
      title: entry.title,
      description: entry.description,
      plugin: entry.source.plugin ?? "",
      path: entry.source.path,
      enabled: entry.invocation.type !== "unavailable",
      providers: entry.source.provider === "ace" ? [] : [entry.source.provider],
      discovered: entry,
    });
    ids.add(id);
  }
  return result;
}
