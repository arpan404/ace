import { ProjectName, WorkspaceId } from "@ace/protocol";
import { command, key } from "../mutations.ts";
import { CliFailure } from "../output.ts";
import { withSession, type CommandContext } from "../run/context.ts";
import { projectListLines, projectShowLines } from "../render/project.ts";
import { resolveProject } from "./daemon.ts";
import { limitFlag, receipt, show, stringFlag } from "./output.ts";
import { listRows } from "./thread-reads.ts";

export async function projectList(context: CommandContext): Promise<void> {
  const limit = limitFlag(context.args, 50, 100);
  const after = stringFlag(context.args, "after");
  return withSession(context, context.args, async ({ client, signal }) => {
    const response = await client.request(
      {
        type: "projects.request",
        operation: {
          op: "workspace.list",
          limit,
          ...(after ? { after: WorkspaceId.parse(after) } : {}),
        },
      },
      { signal },
    );
    if (response.result.kind !== "projects")
      throw new CliFailure(
        "refused",
        response.result.kind === "error" ? response.result.code : "Project list unavailable",
      );
    await show(context.args, response.result, {
      human: (value) => projectListLines(value.projects, value.next),
      quiet: (value) => value.projects.map((project) => project.id),
    });
  });
}

export async function projectShow(context: CommandContext): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    const project = await resolveProject(client, signal, context.args.words[0] ?? ".");
    const { rows } = await listRows(client, signal, { project: project.id, want: 500 });
    const value = {
      project,
      threads: {
        total: rows.length,
        needsYou: rows.filter((row) => row.state === "needs-you").length,
        running: rows.filter((row) =>
          ["working", "waiting", "background", "limited"].includes(row.state),
        ).length,
      },
    };
    await show(context.args, value, {
      human: projectShowLines,
      quiet: (shown) => [shown.project.id],
    });
  });
}

export async function projectRename(context: CommandContext): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    const project = await resolveProject(client, signal, context.args.words[0] ?? "");
    const name = ProjectName.parse(context.args.words[1]);
    const done = await command(
      client,
      { type: "workspace.rename", workspaceId: WorkspaceId.parse(project.id), name },
      key(context.args),
      signal,
    );
    await receipt(context.args, done, () => `Renamed ${project.name} to ${name}.`);
  });
}

export async function projectRemove(context: CommandContext): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    const project = await resolveProject(client, signal, context.args.words[0] ?? "");
    const done = await command(
      client,
      {
        type: "workspace.remove",
        workspaceId: WorkspaceId.parse(project.id),
        stopRunning: context.args.flags["stop-threads"] === true,
      },
      key(context.args),
      signal,
    );
    await receipt(
      context.args,
      done,
      () => `Stopped tracking ${project.name}; its files stay in ${project.path}.`,
    );
  });
}

export async function projectAdd(context: CommandContext): Promise<void> {
  return withSession(context, context.args, async ({ client, signal, remote }) => {
    const { addProject, projectPath } = await import("../projects.ts");
    const added = await addProject(
      client,
      projectPath(context.args.words[0], remote, process.cwd()),
      key(context.args),
      signal,
    );
    await receipt(context.args, added, (value) =>
      value.workspace ? `Added ${value.workspace.name} (${value.workspace.path}).` : "Added.",
    );
  });
}
