import { resolve } from "node:path";
import {
  CliRequestList,
  ThreadId,
  WorkspaceId,
  type Project,
  type ThreadListEntry,
  type ThreadListWindow,
} from "@ace/protocol";
import type { Client, ThreadSource } from "@ace/client";
import { waitSelection } from "../connection.ts";
import { CliFailure, usageFailure } from "../output.ts";
import { resolveRef, threadNoun } from "./refs.ts";

/**
 * The work commands' reads from the daemon: the thread list, projects, open requests and one
 * thread. The thin I/O shell around the pure rules in `rows.ts`, `refs.ts` and `answers.ts`.
 */

/** Pages of the thread list read at most for one command. */
const listPages = 20;

export interface ThreadList {
  readonly entries: readonly ThreadListEntry[];
  readonly window: ThreadListWindow | undefined;
}

/** The thread list, paged in until it holds `want` threads or the list ends. */
export async function readThreadList(
  client: Client,
  signal: AbortSignal,
  input: { project?: string | undefined; want: number },
): Promise<ThreadList> {
  const lease = client.threads();
  try {
    await client.threadsWindow({ project: input.project });
    const loaded = () =>
      waitSelection(
        lease.store.select(["threads", "error", "window"], (reader) => ({
          loaded: reader.loaded,
          error: reader.error,
          before: reader.window?.before,
          count: reader.ids.length,
        })),
        (value) => value.loaded || !!value.error,
        signal,
      );
    await loaded();
    for (let page = 0; page < listPages; page++) {
      if (lease.store.error) throw lease.store.error;
      if (lease.store.ids.length >= input.want || !lease.store.window?.before) break;
      await client.threadsMore({ signal });
      await loaded();
    }
    if (lease.store.error) throw lease.store.error;
    const entries = lease.store.ids.flatMap((id) => {
      const entry = lease.store.thread(id);
      return entry ? [entry] : [];
    });
    return { entries, window: lease.store.window };
  } finally {
    lease.release();
  }
}

/** Every project, up to five pages of a hundred. */
export async function readProjects(client: Client, signal: AbortSignal): Promise<Project[]> {
  const projects: Project[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const result: { projects: readonly Project[]; next: string | null } = await projectPage(
      client,
      signal,
      after,
    );
    projects.push(...result.projects);
    after = result.next;
    if (!after) break;
  }
  return projects;
}

async function projectPage(client: Client, signal: AbortSignal, after: string | null) {
  const response = await client.request(
    {
      type: "projects.request",
      operation: {
        op: "workspace.list",
        limit: 100,
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
  return response.result;
}

export function projectNames(projects: readonly Project[]): Map<string, string> {
  return new Map(projects.map((project) => [project.id, project.name]));
}

/**
 * A project by id, name or path (ADR 0176 §1 rule 5). A path is resolved from `cwd`; a name
 * matches whole, ignoring case; two projects with that name fail naming both. Pure.
 */
export function findProject(projects: readonly Project[], ref: string, cwd: string): Project {
  const byId = projects.find((project) => project.id === ref);
  if (byId) return byId;
  const looksLikePath = ref.startsWith(".") || ref.startsWith("~") || /[/\\]/.test(ref);
  const path = resolve(cwd, ref);
  const byPath = projects.find((project) => project.path === path);
  if (byPath) return byPath;
  if (!looksLikePath) {
    const named = projects.filter((project) => project.name.toLowerCase() === ref.toLowerCase());
    if (named.length === 1 && named[0]) return named[0];
    if (named.length > 1)
      throw usageFailure(`${named.length} projects are named ${ref}.`, {
        code: "ambiguous",
        argument: "PROJECT",
        hint: `Use its id: ${named.map((project) => `${project.id} (${project.path})`).join(", ")}.`,
      });
  }
  throw new CliFailure(
    "refused",
    `No project ${looksLikePath ? "at" : "named"} ${ref}.`,
    undefined,
    {
      code: "not_found",
      argument: "PROJECT",
      hint: "See your projects with ace project list, or add this folder with ace project add.",
    },
  );
}

export async function resolveProject(
  client: Client,
  signal: AbortSignal,
  ref: string,
  cwd = process.cwd(),
): Promise<Project> {
  return findProject(await readProjects(client, signal), ref, cwd);
}

/** A thread named by id or prefix, among the threads the list holds. */
export async function resolveThread(
  client: Client,
  signal: AbortSignal,
  input: string,
): Promise<ThreadId> {
  // The list's first page: a whole id past it still passes through for the daemon to judge.
  const list = await readThreadList(client, signal, { want: 1 });
  const id = resolveRef(
    input,
    list.entries.map((entry) => entry.id),
    threadNoun,
    (value) => ThreadId.safeParse(value).success,
  );
  return ThreadId.parse(id);
}

/** The open requests, across threads or in one thread's tree. */
export async function readRequests(
  client: Client,
  signal: AbortSignal,
  threadId?: ThreadId,
): Promise<CliRequestList> {
  const response = await client.request(
    {
      type: "cli.request",
      operation: { op: "request.list", ...(threadId ? { threadId } : {}), limit: 200 },
    },
    { signal },
  );
  if (!response.result.ok) {
    if (response.result.code === "not_found")
      throw new CliFailure("refused", `No thread ${threadId ?? ""} on this machine.`, undefined, {
        code: "not_found",
        hint: "See your threads with ace thread list.",
      });
    throw new CliFailure("uncertain", "ace couldn't read the open requests.", undefined, {
      hint: "Try again; if it keeps failing, run ace doctor.",
    });
  }
  return CliRequestList.parse(response.result.data);
}

/**
 * One thread held for the length of `use`. A thread the daemon doesn't know fails as not
 * found, naming it.
 */
export async function withThread<T>(
  client: Client,
  id: ThreadId,
  signal: AbortSignal,
  use: (store: ThreadSource) => Promise<T> | T,
): Promise<T> {
  const lease = client.thread(id);
  try {
    await waitSelection(
      lease.store.select(["thread", "error"], (reader) => ({
        thread: reader.thread,
        error: reader.error,
      })),
      (value) => !!value.thread || !!value.error,
      signal,
    );
    if (lease.store.error) {
      // The daemon answers a thread it doesn't hold the same as one this device can't read.
      if (
        /not.?found|unknown|read_denied/i.test(
          `${lease.store.error.code} ${lease.store.error.message}`,
        )
      )
        throw new CliFailure("refused", `No thread ${id} on this machine.`, undefined, {
          code: "not_found",
          argument: "THREAD",
          hint: "See your threads with ace thread list.",
        });
      throw lease.store.error;
    }
    return await use(lease.store);
  } finally {
    lease.release();
  }
}
