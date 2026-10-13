import type { ClientApi } from "@ace/client";
import { SettingsValues } from "@ace/protocol";

/** The daemon refused a project folder; `code` says why (`directory_missing`, …). */
export class ProjectRootRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ProjectRootRefused";
    this.code = code;
  }
}

/** A typed folder path with a leading `~` read as the daemon machine's home folder. */
export async function resolveRootPath(client: ClientApi, typed: string): Promise<string> {
  if (typed !== "~" && !typed.startsWith("~/")) return typed;
  const { result } = await client.projects.home();
  if (result.kind !== "home")
    throw new ProjectRootRefused(result.kind === "error" ? result.code : "project_failed");
  const home = result.path.replace(/\/+$/, "");
  return typed === "~" ? result.path : `${home}/${typed.slice(2)}`.replace(/\/+$/, "");
}

async function allowRoot(client: ClientApi, input: { path: string; create?: true }): Promise<void> {
  const reply = await client.projects.addRoot(input);
  if (!reply.ok) throw new ProjectRootRefused(reply.error ?? "project_failed");
}

/**
 * Allow an existing folder as a project folder; the daemon keeps home allowed when it is the
 * first. A missing folder is refused with `directory_missing`.
 */
export function addProjectRoot(client: ClientApi, path: string): Promise<void> {
  return allowRoot(client, { path });
}

/** Make the folder and any missing parents on the daemon's machine, then allow it. */
export function createProjectRoot(client: ClientApi, path: string): Promise<void> {
  return allowRoot(client, { path, create: true });
}
export async function saveProjectRoots(client: ClientApi, roots: string[]): Promise<void> {
  const value = SettingsValues.shape["projects.roots"].parse(roots);
  const reply = await client.request({
    type: "settings.set",
    key: "projects.roots",
    value,
    layer: { kind: "global" },
  });
  if (!reply.ok)
    throw new Error("Couldn't save allowed folders. Check the folder path and try again.");
}
