import type {
  ProjectCalls,
  ProjectCallsModule,
  ProjectsApi,
  ProjectsClient,
} from "./projects-types.ts";

export type { ProjectCallsModule, ProjectsApi, ProjectsClient } from "./projects-types.ts";

/** Workspace pushes, filtered from a client's service messages. They need no schema of their own. */
export function projectEvents(
  client: ProjectsClient,
): Pick<ProjectsApi, "onChanged" | "onCloneProgress"> {
  return {
    onChanged: (listener) =>
      client.onMessage((message) => {
        if (message.type === "workspace.changed") listener(message);
      }),
    onCloneProgress: (listener) =>
      client.onMessage((message) => {
        if (message.type === "workspace.clone.progress") listener(message);
      }),
  };
}

/**
 * The project API with its calls and their schemas loaded on the first call (ADR 0056), for
 * the page's `RemoteClient`, whose first paint does not load classic Zod. Once loaded, a call
 * runs at once, as if it had never been split; a failed load is retried by the next call.
 */
export function deferredProjectsApi(
  client: ProjectsClient,
  load: () => Promise<ProjectCallsModule>,
): ProjectsApi {
  let calls: ProjectCalls | undefined;
  let loading: Promise<ProjectCalls> | undefined;
  const loaded = () =>
    (loading ??= load().then(
      (module) => (calls = module.projectCalls(client)),
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    ));
  const call = <T>(run: (ready: ProjectCalls) => Promise<T>): Promise<T> =>
    calls ? run(calls) : loaded().then(run);
  return {
    add: (...args) => call((ready) => ready.add(...args)),
    create: (...args) => call((ready) => ready.create(...args)),
    clone: (...args) => call((ready) => ready.clone(...args)),
    rename: (...args) => call((ready) => ready.rename(...args)),
    remove: (...args) => call((ready) => ready.remove(...args)),
    inspect: (...args) => call((ready) => ready.inspect(...args)),
    home: (...args) => call((ready) => ready.home(...args)),
    recentFolders: (...args) => call((ready) => ready.recentFolders(...args)),
    browse: (...args) => call((ready) => ready.browse(...args)),
    search: (...args) => call((ready) => ready.search(...args)),
    complete: (...args) => call((ready) => ready.complete(...args)),
    validateCloneUrl: (...args) => call((ready) => ready.validateCloneUrl(...args)),
    cancelClone: (...args) => call((ready) => ready.cancelClone(...args)),
    ...projectEvents(client),
  };
}
