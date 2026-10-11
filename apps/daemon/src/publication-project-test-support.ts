import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectsOptions } from "./projects.ts";
import { WorkspaceId } from "@ace/protocol";
import { projectFixture } from "./projects-test-support.ts";
import { publicationCli } from "./publication-test-support.ts";

export const input = {
  host: "github.com",
  account: "octo",
  owner: "octo",
  name: "engine",
  description: "A project",
  visibility: "private",
} as const;
export async function setup(
  options: Parameters<typeof publicationCli>[0] = {},
  projects: Pick<ProjectsOptions, "git"> = {},
) {
  const cli = await publicationCli(options);
  const f = await projectFixture({
    ...projects,
    sourceControl: cli.source,
    gitPolicy: { protocols: ["https", "ssh", "file"] },
  });
  const path = join(f.root, "project");
  await mkdir(path);
  await f.git(path, ["init"]);
  const added = await f.command({ type: "workspace.add", path });
  const id = WorkspaceId.parse(added.workspace?.id);
  return {
    ...f,
    cli,
    path,
    id,
    async cleanup() {
      await f.close();
      await cli.close();
    },
    publish: () => f.command({ type: "workspace.publish", workspaceId: id, input }),
  };
}
