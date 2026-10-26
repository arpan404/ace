import type { ClientCore, RequestOptions } from "@ace/client";
import type { Project } from "@ace/protocol";

/** Why the machine's project list couldn't be read: its refusal code, or `invalid_data`. */
export class ProjectListRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * The machine's projects (`workspace.request` › `workspaces.list`), every page in order until
 * `cap` projects that pass `keep` are read. A refusal or a reply of another kind throws
 * `ProjectListRefused`.
 */
export async function readProjects(
  owner: Pick<ClientCore, "request">,
  options: RequestOptions,
  cap: number,
  keep: (project: Project) => boolean = () => true,
): Promise<Project[]> {
  const listed: Project[] = [];
  let after: string | undefined;
  do {
    const reply = await owner.request(
      {
        type: "workspace.request",
        operation: { op: "workspaces.list", limit: 100, ...(after ? { after } : {}) },
      },
      options,
    );
    const result = reply.result;
    if (result.kind === "error") throw new ProjectListRefused(result.code);
    if (result.kind !== "workspaces") throw new ProjectListRefused("invalid_data");
    listed.push(...result.workspaces.filter(keep));
    // A cursor that doesn't move would page forever.
    if (result.next === after) break;
    after = result.next;
  } while (after && listed.length < cap);
  return listed;
}
