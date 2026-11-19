import { resolve, isAbsolute } from "node:path";
import { WorkspaceId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { command } from "./mutations.ts";
import { CliFailure } from "./output.ts";

export function projectPath(value: string | undefined, remote: boolean, cwd: string): string {
  if (remote) {
    if (!value || !isAbsolute(value))
      throw new CliFailure("refused", "Remote project paths must be absolute paths on that host");
    return value;
  }
  return resolve(cwd, value ?? ".");
}
export async function addProject(
  client: Client,
  path: string,
  id: string,
  signal: AbortSignal,
  submit: typeof command = command,
) {
  const receipt = await submit(client, { type: "workspace.add", path }, id, signal);
  if (!receipt.workspace)
    throw new CliFailure("uncertain", "Project registration returned no identity", receipt);
  return receipt;
}
export async function getProject(client: Client, id: string, signal: AbortSignal) {
  const response = await client.request(
    {
      type: "projects.request",
      operation: { op: "workspace.get", workspaceId: WorkspaceId.parse(id) },
    },
    { signal },
  );
  if (response.result.kind !== "project")
    throw new CliFailure(
      "refused",
      response.result.kind === "error" ? response.result.code : "Project facts unavailable",
    );
  return response.result.project;
}
/** Remote work binds to a registered host identity, never a client-resolved directory. */
export async function remoteWorkProject(
  value: string | undefined,
  client: Client,
  signal: AbortSignal,
) {
  if (!value || value.startsWith(".") || /[/\\]/.test(value))
    throw new CliFailure(
      "refused",
      "Remote work requires --project WORKSPACE_ID from ace project list; paths are not accepted",
    );
  return (await getProject(client, value, signal)).id;
}
