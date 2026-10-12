import { resolve, isAbsolute } from "node:path";
import { ProjectName, WorkspaceId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { command, key } from "./mutations.ts";
import { mutationResult, result } from "./io.ts";
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
export async function projectCommand(
  args: Args,
  client: Client,
  signal: AbortSignal,
  remote: boolean,
) {
  const alias = args.words[0] === "add";
  const verb = alias ? "add" : args.words[1];
  const position = alias ? 1 : 2;
  if (verb === "add") {
    validateArgs(args, ["idempotency-key"], position, position + 1);
    return mutationResult(
      args,
      await addProject(
        client,
        projectPath(args.words[position], remote, process.cwd()),
        key(args),
        signal,
      ),
    );
  }
  if (verb === "list") {
    validateArgs(args, ["after", "limit"], 2);
    const value = option(args, "limit") ?? "50";
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)
      throw new CliFailure("refused", "Project list limit must be 1-100");
    const response = await client.request(
      {
        type: "projects.request",
        operation: {
          op: "workspace.list",
          after: option(args, "after") ? WorkspaceId.parse(option(args, "after")) : undefined,
          limit: Number(value),
        },
      },
      { signal },
    );
    if (response.result.kind !== "projects")
      throw new CliFailure(
        "refused",
        response.result.kind === "error" ? response.result.code : "Project list unavailable",
      );
    return result(args, response.result);
  }
  if (verb === "rename" || verb === "remove") {
    validateArgs(args, ["idempotency-key", "archive-threads"], verb === "rename" ? 4 : 3);
    return mutationResult(
      args,
      await command(
        client,
        verb === "rename"
          ? {
              type: "workspace.rename",
              workspaceId: WorkspaceId.parse(args.words[2]),
              name: ProjectName.parse(args.words[3]),
            }
          : {
              type: "workspace.remove",
              workspaceId: WorkspaceId.parse(args.words[2]),
              archiveThreads: !!args.flags["archive-threads"],
            },
        key(args),
        signal,
      ),
    );
  }
  throw new CliFailure("refused", "Usage: ace project add|list|rename|remove|open");
}
