import type { PermissionMode, ProviderKind } from "@ace/protocol";
import { permissionModes } from "@ace/client";
import { useEffect, useMemo, useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import {
  Composer,
  PermissionPicker,
  preloadComposerParts,
  useDraftScope,
  usePermissionCapabilities,
  type Draft,
} from "@/features/thread/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { whenIdle } from "@/lib/idle.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useRegisteredProjects } from "@/lib/projects.ts";
import { useStartingProvider } from "@/lib/provider-statuses.ts";
import { ProjectsEmptyState } from "@/features/projects/index.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { WorkspaceId } from "@ace/protocol";
import { speedOffTier } from "@ace/ui-core";
import { loadChoices, pickProject, resolve, saveChoices, type Choices } from "./choices.ts";
import { ContextBar } from "./context-bar.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { useBranches } from "@/lib/branches.ts";
import { useNewThreadOptions } from "@/features/models/index.ts";
import { useCreateThread } from "./use-create-thread.ts";

/**
 * ⌘N: pick a project, a model and account, how actions get approved, a worktree or the local
 * checkout, and describe the work. The thread is created when the message is sent, then opens.
 * Mentions, files and slash commands work before then, in a draft scope on the daemon.
 */
export function NewThreadPage(props: { project?: string | undefined; base?: string | undefined }) {
  const { storage } = useLayout();
  const { project: filter } = useOrganizerState();
  const { ids: projects, name, loaded } = useRegisteredProjects();
  const [choices, setChoices] = useState<Choices>(() => loadChoices(storage));
  const [requested, setRequested] = useState(props.project);
  const project = pickProject(projects, requested, choices.project, filter);
  const projectName = project === undefined ? undefined : name(project);
  const [baseChoice, setBase] = useState(props.base);
  const { create, sending, error } = useCreateThread();
  useEffect(() => whenIdle(() => void preloadComposerParts()), []);

  // Until the starting provider is known, show models loading rather than a provider to undo.
  const start = useStartingProvider();
  const catalog = useNewThreadOptions();
  const options = start.loaded ? catalog : undefined;
  const [picked, setPicked] = useState<ProviderKind>();
  const resolved = resolve(options, choices, picked ?? start.provider);
  const branches = useBranches(project);
  const base = baseChoice && branches.includes(baseChoice) ? baseChoice : branches[0];
  const provider = resolved.model?.provider;

  // Approvals start at the daemon's default for the project; a choice here applies to this
  // thread only and isn't remembered, so full access is never carried into the next thread.
  const [permission, setPermission] = useState<PermissionMode>();
  const [defaultMode] = useDaemonSetting(
    "permissions.defaultMode",
    project ? { workspaceId: WorkspaceId.parse(project) } : {},
  );
  const permissions = usePermissionCapabilities(provider);
  const supported = permissionModes(permissions.capabilities);
  const chosen = permission && supported.includes(permission) ? permission : undefined;

  const choose = (patch: Partial<Choices>) => {
    const next = { ...choices, ...patch };
    setChoices(next);
    saveChoices(storage, next);
  };
  // A model remembered as a bare id (before option keys) is saved under its option key, again
  // after any later choice saves the bare id it still holds.
  const upgraded = resolved.upgradedModel;
  useEffect(() => {
    if (upgraded !== undefined) saveChoices(storage, { ...choices, model: upgraded });
  }, [upgraded, choices, storage]);
  // Mentions, uploads and slash commands go to a draft scope on the daemon before the thread
  // exists; the new thread adopts it. A draft ref's id is that scope.
  const scope = useDraftScope(project);
  const accountId = resolved.account?.id;
  const draftThread = useMemo(
    () => ({
      id: scope.draftId ?? "",
      workspaceId: project ?? "",
      title: "",
      draft: true,
      provider,
      instanceId: accountId,
    }),
    [scope.draftId, project, provider, accountId],
  );
  const send = async (draft: Draft) => {
    if (sending || !project || !resolved.model) return false;
    choose({ project });
    const draftId = scope.draftId;
    const created = await create({
      project,
      provider: resolved.model.provider,
      model: resolved.model.fromCatalog ? resolved.model.id : undefined,
      account: resolved.account?.id,
      mode: resolved.mode,
      baseBranch: base,
      effort: resolved.effort,
      serviceTier: resolved.fast ? resolved.model.fastTier : speedOffTier(resolved.model),
      permission: chosen,
      text: draft.text.trim() || "See the attached files.",
      context: {
        ...(draftId ? { draftId } : {}),
        mentions: draft.mentions,
        attachments: draft.attachments,
      },
    });
    if (created) scope.adopt();
    return created;
  };

  // The first run: nothing to start a thread in until a project is added.
  if (loaded && !projects.length)
    return (
      <Screen title="New thread">
        <ProjectsEmptyState />
      </Screen>
    );
  return (
    <Screen title="New thread" subtitle={projectName}>
      <div className="flex h-full flex-col justify-center overflow-y-auto px-5 pt-8 pb-[12vh] sm:px-8">
        <div className="mx-auto w-full max-w-(--column)">
          <h2 className="mb-5 px-1 text-2xl font-semibold tracking-title text-foreground">
            What should we work on{projectName ? ` in ${projectName}` : ""}?
          </h2>
          <Composer
            thread={draftThread}
            draftKey={project ? `new:${project}` : undefined}
            busy={false}
            onSubmit={send}
            autoFocus
            placeholder="Describe the change, a bug, or a question. @ to mention a file"
            controls={
              <>
                <ModelPicker
                  options={options}
                  resolved={resolved}
                  onModel={(model) => {
                    setPicked(options?.models.find((m) => m.key === model)?.provider);
                    choose({ model, account: undefined, effort: undefined, fast: undefined });
                  }}
                  onAccount={(account) => choose({ account })}
                  onEffort={(effort) => choose({ effort })}
                  onFast={(fast) => choose({ fast })}
                  onReset={() => choose({ effort: undefined, fast: undefined })}
                />
                <PermissionPicker
                  mode={chosen ?? defaultMode}
                  capabilities={permissions.capabilities}
                  provider={provider}
                  loading={!!provider && (permissions.loading || defaultMode === undefined)}
                  unavailable={
                    permissions.failed
                      ? "The daemon couldn't say what this provider can gate"
                      : undefined
                  }
                  inherited={!chosen}
                  onChange={(mode) => setPermission(mode ?? undefined)}
                />
              </>
            }
          />
          <ContextBar
            projects={projects}
            projectName={name}
            project={project}
            onProject={(next) => {
              setRequested(next);
              setBase(undefined);
              choose({ project: next });
            }}
            mode={resolved.mode}
            onMode={(mode) => choose({ mode })}
            branches={branches}
            base={base}
            onBase={setBase}
          />
          {error && (
            <p role="alert" className="mt-3 px-2 text-ui text-status-failed">
              {error}
            </p>
          )}
        </div>
      </div>
    </Screen>
  );
}
