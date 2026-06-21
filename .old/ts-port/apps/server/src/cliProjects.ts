import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  type OrchestrationReadModel,
  ProjectId,
  type ModelSelection,
} from "@ace/contracts";
import { Data, Effect, Layer, Option } from "effect";

import {
  deriveProjectTitleFromWorkspaceRoot,
  normalizeCliWorkspaceRoot,
  resolveCliPath,
} from "./cliPaths";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";

export interface CliProjectSummary {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeThreadCount: number;
}

export interface AddCliProjectResult {
  readonly status: "created" | "existing";
  readonly project: CliProjectSummary;
}

export interface RemoveCliProjectResult {
  readonly project: CliProjectSummary;
  readonly deletedThreadCount: number;
}

export class CliProjectCommandError extends Data.TaggedError("CliProjectCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const DEFAULT_PROJECT_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: DEFAULT_MODEL_BY_PROVIDER.codex,
};

const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
).pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

export const CliProjectServicesLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);

const buildProjectSummaries = (snapshot: OrchestrationReadModel) => {
  const activeThreads = snapshot.threads.filter((thread) => thread.deletedAt === null);
  const activeThreadCountsByProjectId = new Map<ProjectId, number>();

  for (const thread of activeThreads) {
    activeThreadCountsByProjectId.set(
      thread.projectId,
      (activeThreadCountsByProjectId.get(thread.projectId) ?? 0) + 1,
    );
  }

  return snapshot.projects
    .filter((project) => project.deletedAt === null)
    .map(
      (project): CliProjectSummary => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModelSelection: project.defaultModelSelection,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        activeThreadCount: activeThreadCountsByProjectId.get(project.id) ?? 0,
      }),
    );
};

const loadCliProjectSnapshot = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getSnapshot({
    hydrateThreadId: null,
  });
});

const ensureNonEmptyProjectTitle = (title: string | undefined) => {
  const trimmedTitle = title?.trim();
  if (trimmedTitle && trimmedTitle.length > 0) {
    return trimmedTitle;
  }
  if (title !== undefined) {
    return undefined;
  }
  return undefined;
};

const findProjectSummaryById = Effect.fn("findProjectSummaryById")(function* (
  projectId: ProjectId,
) {
  const projects = yield* listCliProjects;
  const project = projects.find((candidate) => candidate.id === projectId);

  if (project) {
    return project;
  }

  return yield* new CliProjectCommandError({
    message: `Project '${projectId}' was not found after dispatch.`,
  });
});

const isPathLikeSelector = (selector: string): boolean =>
  selector.startsWith(".") ||
  selector.startsWith("~") ||
  selector.includes("/") ||
  selector.includes("\\");

const requireSingleProjectMatch = (
  selector: string,
  matches: ReadonlyArray<CliProjectSummary>,
): Effect.Effect<CliProjectSummary, CliProjectCommandError> => {
  if (matches.length === 1) {
    return Effect.succeed(matches[0]!);
  }

  if (matches.length > 1) {
    return Effect.fail(
      new CliProjectCommandError({
        message: `Multiple projects match '${selector}'. Use the project id or full workspace path.`,
      }),
    );
  }

  return Effect.fail(
    new CliProjectCommandError({
      message: `Project '${selector}' was not found.`,
    }),
  );
};

const resolveCliProjectSelector = Effect.fn("resolveCliProjectSelector")(function* (
  selector: string,
) {
  const trimmedSelector = selector.trim();
  const projects = yield* listCliProjects;

  const idMatches = projects.filter((project) => project.id === trimmedSelector);
  if (idMatches.length > 0) {
    return yield* requireSingleProjectMatch(trimmedSelector, idMatches);
  }

  const exactWorkspaceMatches = projects.filter(
    (project) => project.workspaceRoot === trimmedSelector,
  );
  if (exactWorkspaceMatches.length > 0) {
    return yield* requireSingleProjectMatch(trimmedSelector, exactWorkspaceMatches);
  }

  const titleMatches = projects.filter((project) => project.title === trimmedSelector);
  if (titleMatches.length > 0) {
    return yield* requireSingleProjectMatch(trimmedSelector, titleMatches);
  }

  if (!isPathLikeSelector(trimmedSelector)) {
    return yield* new CliProjectCommandError({
      message: `Project '${trimmedSelector}' was not found.`,
    });
  }

  const normalizedSelectorPath = yield* resolveCliPath(trimmedSelector);
  const normalizedPathMatches = projects.filter(
    (project) => project.workspaceRoot === normalizedSelectorPath,
  );
  return yield* requireSingleProjectMatch(trimmedSelector, normalizedPathMatches);
});

export const listCliProjects = Effect.gen(function* () {
  const snapshot = yield* loadCliProjectSnapshot;
  return buildProjectSummaries(snapshot);
});

export const addCliProject = Effect.fn("addCliProject")(function* (input: {
  readonly workspaceRoot: string;
  readonly title?: string;
}) {
  const normalizedWorkspaceRoot = yield* normalizeCliWorkspaceRoot(input.workspaceRoot);
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const existingProject =
    yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(normalizedWorkspaceRoot);

  if (Option.isSome(existingProject)) {
    return {
      status: "existing" as const,
      project: yield* findProjectSummaryById(existingProject.value.id),
    } satisfies AddCliProjectResult;
  }

  const explicitTitle = ensureNonEmptyProjectTitle(input.title);
  if (input.title !== undefined && explicitTitle === undefined) {
    return yield* new CliProjectCommandError({
      message: "Project title cannot be empty.",
    });
  }

  const title =
    explicitTitle ?? (yield* deriveProjectTitleFromWorkspaceRoot(normalizedWorkspaceRoot));
  const createdAt = new Date().toISOString();
  const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
  const orchestrationEngine = yield* OrchestrationEngineService;

  yield* orchestrationEngine.dispatch({
    type: "project.create",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    projectId,
    title,
    workspaceRoot: normalizedWorkspaceRoot,
    defaultModelSelection: DEFAULT_PROJECT_MODEL_SELECTION,
    createdAt,
  });

  return {
    status: "created" as const,
    project: yield* findProjectSummaryById(projectId),
  } satisfies AddCliProjectResult;
});

export const removeCliProject = Effect.fn("removeCliProject")(function* (input: {
  readonly selector: string;
  readonly force: boolean;
}) {
  const project = yield* resolveCliProjectSelector(input.selector);

  if (!input.force && project.activeThreadCount > 0) {
    return yield* new CliProjectCommandError({
      message: `Project '${project.title}' still has ${project.activeThreadCount} thread${project.activeThreadCount === 1 ? "" : "s"}. Re-run with --force to delete them too.`,
    });
  }

  const snapshot = yield* loadCliProjectSnapshot;
  const activeThreads = snapshot.threads.filter(
    (thread) => thread.projectId === project.id && thread.deletedAt === null,
  );
  const orchestrationEngine = yield* OrchestrationEngineService;

  if (input.force) {
    for (const thread of activeThreads) {
      yield* orchestrationEngine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: thread.id,
      });
    }
  }

  yield* orchestrationEngine.dispatch({
    type: "project.delete",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    projectId: project.id,
  });

  return {
    project,
    deletedThreadCount: input.force ? activeThreads.length : 0,
  } satisfies RemoveCliProjectResult;
});
