import { usePrSource } from "@/features/forge/index.ts";
import { PastSessions } from "@/features/history/index.ts";
import { ProjectPicker } from "./project-picker.tsx";
import type { BranchRef, PermissionMode, ProviderKind, WorktreeBase } from "@ace/protocol";
import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import {
  Composer,
  PermissionPicker,
  preloadComposerParts,
  rememberAttachments,
  useDraftScope,
  usePermissionModes,
  type Draft,
  type ComposerHandle,
} from "@/features/thread/index.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { whenIdle } from "@/lib/idle.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useRegisteredProjects } from "@/lib/projects.ts";
import { useStartingProvider } from "@/lib/provider-statuses.ts";
import { ProjectsEmptyState } from "@/features/projects/index.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { WorkspaceId } from "@ace/protocol";
import {
  readJson,
  defaultWorktreeBase,
  permissionUnavailable,
  permissionCoverage,
  permissionOption,
  permissionOptions,
  providerNames,
  speedOffTier,
} from "@ace/ui-core";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { loadChoices, pickProject, resolve, saveChoices, type Choices } from "./choices.ts";
import { ModelPicker } from "./model-picker.tsx";
import { useBaseRefs } from "@/lib/branches.ts";
import { useNewThreadOptions } from "@/features/models/index.ts";
import { useCreateThread } from "./use-create-thread.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import * as z from "zod/mini";
import { SignInNotice } from "@/features/sign-in/index.ts";

/** Where the thread runs, below the composer. */
const DeferredEnvironment = deferredComponent(() =>
  import("./environment-strip.tsx").then((module) => module.NewThreadEnvironment),
);

/**
 * A base asked for by name (`?base=` from a branch's "New thread from here"): the remote's copy
 * when the name is `<remote>/<branch>` and the project lists it, else a local branch.
 */
function namedBase(name: string, refs: readonly BranchRef[]): WorktreeBase {
  const remote = refs.find((ref) => ref.remote && `${ref.remote}/${ref.name}` === name);
  return remote?.remote ? { ref: remote.name, remote: remote.remote } : { ref: name };
}

/** Keep the draft identity stable without borrowing mutable resolution objects. */
function useDraftThreadRef(
  draftId: string | undefined,
  project: string | undefined,
  provider: ProviderKind | undefined,
  accountId: string | undefined,
  retryDraftScope: () => void,
) {
  return useMemo(
    () => ({
      id: draftId ?? "",
      workspaceId: project ?? "",
      title: "",
      draft: true,
      provider,
      instanceId: accountId,
      retryDraftScope,
    }),
    [draftId, project, provider, accountId, retryDraftScope],
  );
}

/**
 * ⌘N: pick a project, a model and account, how actions get approved, where it runs (a new
 * worktree from a local or remote branch, or the local checkout), and describe the work. Enter
 * opens the thread at once, with the message as its first bubble, while the daemon creates it
 * (and its worktree). Mentions, files and slash commands work before then, in a draft scope on
 * the daemon.
 */

export function NewThreadPage(props: {
  project?: string | undefined;
  base?: string | undefined;
  skill?: string | undefined;
  pullRequest?: string | undefined;
}) {
  const { storage } = useLayout();
  const readinessId = useId();
  const { project: filter } = useOrganizerState();
  const { ids: projects, name, loaded } = useRegisteredProjects();
  const [choices, setChoices] = useState<Choices>(() => loadChoices(storage));
  const [requested, setRequested] = useState(props.project);
  const project = pickProject(projects, requested, choices.project, filter);
  const prSource = usePrSource(project, props.pullRequest);
  const [baseChoice, setBase] = useState<WorktreeBase | string | undefined>(props.base);
  const page = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const [scopeSaveFailed, setScopeSaveFailed] = useState(false);
  useEffect(() => whenIdle(() => void preloadComposerParts()), []);

  // Until the starting provider is known, show models loading rather than a provider to undo.
  const start = useStartingProvider();
  const catalog = useNewThreadOptions();
  const options = start.loaded ? catalog : undefined;
  const [picked, setPicked] = useState<ProviderKind>();
  const [useWorktree] = useDaemonSetting("threads.useWorktree");
  const selected = resolve(
    options,
    choices,
    picked ?? start.provider,
    useWorktree === false ? "local" : "worktree",
  );
  const resolved = props.pullRequest ? { ...selected, mode: "worktree" as const } : selected;
  const branches = useBaseRefs(project);
  // The base picked here, else the one asked for by name (a local branch until the branches
  // say otherwise), else the default branch at its freshest; undefined while the branches load
  // (the daemon then starts from HEAD).
  const base =
    typeof baseChoice === "object"
      ? baseChoice
      : baseChoice !== undefined
        ? namedBase(baseChoice, branches.refs)
        : defaultWorktreeBase(branches.refs, branches.defaultBranch);
  const provider = resolved.provider;

  // Keep explicit choices across account/provider changes; null is an intentional reset.
  const [permission, setPermission] = useState<PermissionMode | null>();
  const [defaultMode] = useDaemonSetting(
    "permissions.providerModes",
    project ? { workspaceId: WorkspaceId.parse(project) } : {},
  );
  const permissions = usePermissionModes(provider, {
    instanceId: resolved.account?.id,
    currentId: permission !== undefined ? permission : provider ? defaultMode?.[provider] : null,
    setCurrentId: setPermission,
  });
  const admitted = {
    mode: permissions.currentId ?? undefined,
    fallback: provider
      ? permissionUnavailable(
          permissions.capabilities,
          permissions.currentId,
          providerNames[provider],
        )
      : undefined,
  };
  const chosen = permission === undefined ? undefined : (permissions.currentId ?? undefined);

  const choose = (patch: Partial<Choices>) => {
    const next = { ...choices, ...patch };
    setChoices(next);
    saveChoices(storage, next);
  };
  const chooseProject = (next: string) => {
    setRequested(next);
    setBase(undefined);
    choose({ project: next });
  };
  const draftKeyFor = (id: string) =>
    `new:${id}${props.skill ? `:skill:${props.skill}` : ""}${props.pullRequest ? `:pr:${props.pullRequest}` : ""}`;
  // A model remembered as a bare id (before option keys) is saved under its option key, again
  // after any later choice saves the bare id it still holds.
  const upgraded = resolved.upgradedModel;
  useEffect(() => {
    if (upgraded !== undefined) saveChoices(storage, { ...choices, model: upgraded });
  }, [upgraded, choices, storage]);
  // Mentions, uploads and slash commands go to a draft scope on the daemon before the thread
  // exists; the new thread adopts it. A draft ref's id is that scope.
  const host = useHostIdentity()?.hostId;
  const scopeKey =
    host && project
      ? `ace.composer.scope:${JSON.stringify([host, draftKeyFor(project)])}`
      : undefined;
  const readScope = () =>
    scopeKey ? readJson(storage, scopeKey, z.string(), undefined) : undefined;
  const saveScope = (value: string | null): boolean => {
    if (!scopeKey || !storage || storage.durable === false) return false;
    try {
      storage.setItem(scopeKey, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const scope = useDraftScope(host ? project : undefined, {
    read: readScope,
    granted(id) {
      setScopeSaveFailed(!saveScope(id));
    },
    owns: (id) => readScope() === id,
  });
  const { create, error, recovering } = useCreateThread((payload) => {
    if (payload.context?.draftId) {
      scope.retire(payload.context.draftId);
      if (payload.workspaceId === project && readScope() === payload.context.draftId)
        setScopeSaveFailed(!saveScope(null));
    }
    if (payload.workspaceId === project) composer.current?.discardIfSubmitted(payload);
  });
  const accountId = resolved.account?.id;
  const draftThread = useDraftThreadRef(scope.draftId, project, provider, accountId, scope.retry);
  const waitingForAdmission =
    !start.loaded ||
    options === undefined ||
    (!!provider && (defaultMode === undefined || permissions.loading));
  const admissionProblem = recovering
    ? "Recovering the previous thread start…"
    : waitingForAdmission
      ? "Checking provider settings…"
      : permissions.failed
        ? "Couldn't check provider permissions. Reconnect and try again."
        : !scope.draftId
          ? "Preparing attachment storage…"
          : !resolved.model
            ? "No model selected. Open the model menu to refresh or sign in."
            : admitted.fallback;
  const send = async (draft: Draft) => {
    if (!project || !resolved.model || admissionProblem || prSource.problem || !scope.draftId)
      return false;
    choose({ project });
    const draftId = scope.draftId;
    // The new thread takes the draft scope over: keep it when this page closes, which is now.
    scope.adopt();
    // Its first bubble shows the files as they were attached, until the daemon echoes them.
    void draft.files.settled.then((ready) => rememberAttachments(draft.files.local, ready));
    const sent = await create({
      project,
      draftKey: draftKeyFor(project),
      pullRequest: prSource.selection,
      scope: resolved.model.scope,
      model: resolved.model.id,
      mode: resolved.mode,
      base,
      effort: resolved.effort,
      serviceTier: resolved.fast ? resolved.model.fastTier : speedOffTier(resolved.model),
      permission: chosen,
      input: draft.input,
      text: draft.text.trim() || "See the attached files.",
      context: {
        ...(draftId ? { draftId } : {}),
        items: draft.threadRefs,
        mentions: draft.mentions,
        attachments: draft.attachments,
      },
    });
    // Durable admission hands this scope to the thread. Later composition must allocate its own.
    // A refused save still needs the original scope to restore and resubmit its files.
    if (sent) {
      scope.retire(draftId);
      if (readScope() === draftId) setScopeSaveFailed(!saveScope(null));
    }
    return sent;
  };

  const toMessage = () =>
    page.current?.querySelector<HTMLElement>('[role="combobox"][contenteditable]')?.focus();

  // Mount only after the project-scoped draft key is known, so restoration cannot race
  // the project directory on a fresh load.
  if (!loaded)
    return (
      <Screen title="New thread">
        <p role="status" className="px-5 py-6 text-sm text-muted-foreground">
          Loading projects…
        </p>
      </Screen>
    );
  // The first run: nothing to start a thread in until a project is added.
  if (loaded && !projects.length)
    return (
      <Screen title="New thread">
        <ProjectsEmptyState />
      </Screen>
    );
  return (
    <Screen title="New thread">
      <div
        ref={page}
        className="flex h-full min-h-0 flex-col overflow-y-auto px-5 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8"
      >
        <div className="mx-auto flex h-full min-h-0 w-full max-w-(--column) flex-col">
          <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto text-center">
            <div className="my-auto shrink-0 py-8">
              <div
                aria-hidden
                className="mb-4 text-2xl font-semibold tracking-title text-foreground"
              >
                ace
              </div>
              <h2 className="text-xl font-normal tracking-title text-muted-foreground">
                What should we work on in{" "}
                <ProjectPicker
                  variant="inline"
                  projects={projects}
                  projectName={name}
                  project={project}
                  onProject={chooseProject}
                />
                ?
              </h2>
            </div>
          </div>
          <div className="shrink-0">
            <Composer
              ref={composer}
              key={`${project}:${prSource.selection ? JSON.stringify(prSource.selection) : ""}`}
              onPlan={() => {
                if (provider === "claude") setPermission("plan");
              }}
              thread={draftThread}
              draftKey={project ? draftKeyFor(project) : undefined}
              initialText={prSource.text ?? (props.skill ? `/${props.skill} ` : undefined)}
              keepsAttachments
              busy={false}
              sendBlocked={
                admissionProblem || prSource.problem
                  ? { reason: admissionProblem || prSource.problem || "", describedBy: readinessId }
                  : undefined
              }
              onSubmit={send}
              autoFocus
              placeholder="Describe the change, a bug, or a question. @ to mention a file"
              shortPlaceholder="Describe a change or a bug"
              environment={
                <Suspense fallback={null}>
                  <DeferredEnvironment.Component
                    projectControl={
                      <ProjectPicker
                        labelPrefix="Setup project"
                        projects={projects}
                        projectName={name}
                        project={project}
                        onProject={chooseProject}
                      />
                    }
                    pullRequest={
                      props.pullRequest
                        ? {
                            number: prSource.selection?.ref.number,
                            headSha: prSource.selection?.headSha,
                          }
                        : undefined
                    }
                    mode={resolved.mode}
                    onMode={(mode) => choose({ mode })}
                    branches={branches}
                    base={base}
                    onBase={(next) => {
                      setBase(next);
                      toMessage();
                    }}
                  />
                </Suspense>
              }
              trailing={
                <ModelPicker
                  options={options}
                  resolved={resolved}
                  onModel={(model, listed) => {
                    const rows = options?.models.filter((m) => m.key === model) ?? [];
                    setPicked(rows[0]?.provider);
                    // The account the row was listed under; else stay on the chosen account
                    // when it serves the model; else one that does.
                    const under = options?.accounts.some((account) => account.id === listed);
                    const stays = rows.some((m) => m.account === choices.account);
                    choose({
                      model,
                      account: under ? listed : stays ? choices.account : undefined,
                      effort: undefined,
                      fast: undefined,
                    });
                  }}
                  onAccount={(account) => choose({ account })}
                  onEffort={(effort) => choose({ effort })}
                  onFast={(fast) => choose({ fast })}
                  onReset={() => choose({ effort: undefined, fast: undefined })}
                />
              }
              controls={
                <PermissionPicker
                  current={
                    waitingForAdmission
                      ? undefined
                      : permissionOption(admitted.mode ?? null, permissions.capabilities)
                  }
                  detail={
                    admitted.mode && permissionCoverage(permissions.capabilities, admitted.mode)
                  }
                  inherited={!chosen}
                  menu={{
                    options: permissionOptions(permissions.capabilities),
                    value: admitted.mode,
                    loading: waitingForAdmission,
                    unavailable: permissions.failed
                      ? "Couldn't load permission modes. Reconnect and try again."
                      : undefined,

                    fallback: admitted.fallback,
                  }}
                  onChange={permissions.setCurrentId}
                />
              }
            />
            {(admissionProblem || prSource.problem) && (
              <p id={readinessId} role="status" className="mt-2 px-4 text-xs text-muted-foreground">
                {admissionProblem || prSource.problem}
              </p>
            )}
            <SignInNotice provider={provider} />
            <PastSessions />
            {error && (
              <p role="alert" className="mt-3 px-2 text-ui text-status-failed">
                {error}
              </p>
            )}
            {scopeSaveFailed && (
              <p role="alert" className="mt-3 px-2 text-ui text-status-failed">
                Couldn't save attachment storage ownership. Keep this editor open until this device
                has free space.
              </p>
            )}
          </div>
        </div>
      </div>
    </Screen>
  );
}
