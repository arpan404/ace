// TODO(train-2): wire to protocol when merged
/*
 * The Skills catalog: skills, plugins (plugins service) and slash commands (command library,
 * #46). None is readable over the wire on this branch, so the catalog comes from the fake
 * backend in fake mode and is unavailable against a real daemon. Components use the hooks
 * below only.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { UnavailableError, useFakeBackend, type FakeBackend } from "@/boot/fake-backend.ts";

export type SkillKind = "skill" | "plugin" | "command";
export type SkillSource = "repo" | "user" | "plugin";
export interface Skill {
  id: string;
  kind: SkillKind;
  name: string;
  description: string;
  source: SkillSource;
  location: string;
  usage: string;
  availability: string;
  enabled: boolean;
  preview: string;
}

/** Where a skill may run. Labels double as the catalog's "Available to" sentence. */
export const availabilities = [
  "Every provider that supports skills. Codex and OpenCode load it as a prompt.",
  "Claude Code only.",
  "Codex only.",
] as const;

/** A plugin repository as `owner/name`, or a git URL. */
export const PluginRepository = z
  .string()
  .trim()
  .regex(
    /^(?:[\w.-]+\/[\w.-]+|https:\/\/\S+\.git)$/,
    "Use owner/name or an https URL ending in .git.",
  );

/** "getsentry/sentry-mcp" → "sentry-mcp": the plugin's id and name. */
export function pluginName(repository: string): string {
  return (
    repository
      .replace(/\.git$/, "")
      .split("/")
      .at(-1)
      ?.toLowerCase() ?? ""
  );
}

const key = ["skills"] as const;

async function loaded(backend: Promise<FakeBackend> | null): Promise<FakeBackend> {
  if (!backend) throw new UnavailableError("Skills");
  return backend;
}

export function useSkills() {
  const backend = useFakeBackend();
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<Skill[]> => [...(await loaded(backend)).skills],
  });
}

function useUpdate<T>(change: (backend: FakeBackend, input: T) => void) {
  const backend = useFakeBackend();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: T) => change(await loaded(backend), input),
    onSuccess: () => queries.invalidateQueries({ queryKey: key }),
  });
}

const patch = (backend: FakeBackend, id: string, next: Partial<Skill>) => {
  backend.skills = backend.skills.map((skill) => (skill.id === id ? { ...skill, ...next } : skill));
};

export function useSetSkillEnabled() {
  return useUpdate((backend, input: { id: string; enabled: boolean }) =>
    patch(backend, input.id, { enabled: input.enabled }),
  );
}

export function useSetAvailability() {
  return useUpdate((backend, input: { id: string; availability: string }) =>
    patch(backend, input.id, { availability: input.availability }),
  );
}

/** Install a plugin from a repository. The real flow reviews its executions first. */
export function useInstallPlugin() {
  return useUpdate((backend, repository: string) => {
    const name = pluginName(PluginRepository.parse(repository));
    if (!name) throw new Error("That repository has no name.");
    if (backend.skills.some((skill) => skill.id === name))
      throw new Error(`${name} is already installed.`);
    backend.skills = [
      ...backend.skills,
      {
        id: name,
        kind: "plugin",
        name,
        description: `Installed from ${repository}`,
        source: "plugin",
        location: `Plugin · ${repository}`,
        usage: "Not used yet",
        availability: availabilities[0],
        enabled: true,
        preview: `${name} plugin\n\nInstalled from ${repository}.`,
      },
    ];
  });
}
