import type { BranchRef, PermissionMode, ProviderKind, WorktreeBase } from "@ace/protocol";
import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import {
  Composer,
  EnvironmentPill,
  PermissionPicker,
  preloadComposerParts,
  rememberAttachments,
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
import {
  baseName,
  defaultWorktreeBase,
  permissionAdmission,
  providerNames,
  speedOffTier,
} from "@ace/ui-core";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { loadChoices, pickProject, resolve, saveChoices, type Choices } from "./choices.ts";
import { ModelPicker } from "./model-picker.tsx";
import { ProjectPicker } from "./project-picker.tsx";
import { useBaseRefs } from "@/lib/branches.ts";
import { useNewThreadOptions } from "@/features/models/index.ts";
import { useCreateThread } from "./use-create-thread.ts";
import { SignInNotice } from "@/features/sign-in/index.ts";

/** Where the thread runs, opened from the composer's environment pill. */
const DeferredEnvironmentCard = deferredComponent(() =>
  import("./environment-card.tsx").then((module) => module.NewThreadEnvironmentCard),
);

/**
 * A base asked for by name (`?base=` from a branch's "New thread from here"): the remote's copy
 * when the name is `<remote>/<branch>` and the project lists it, else a local branch.
 */
function namedBase(name: string, refs: readonly BranchRef[]): WorktreeBase {
  const remote = refs.find((ref) => ref.remote && `${ref.remote}/${ref.name}` === name);
  return remote?.remote ? { ref: remote.name, remote: remote.remote } : { ref: name };
}

/**
 * ⌘N: pick a project, a model and account, how actions get approved, where it runs (a new
 * worktree from a local or remote branch, or the local checkout), and describe the work. Enter
 * opens the thread at once, with the message as its first bubble, while the daemon creates it
 * (and its worktree). Mentions, files and slash commands work before then, in a draft scope on
 * the daemon.
 */
export function NewThreadPage(props: { project?: string | undefined; base?: string | undefined }) {
  const { storage } = useLayout();
  const { project: filter } = useOrganizerState();
  const { ids: projects, name, loaded } = useRegisteredProjects();
  const [choices, setChoices] = useState<Choices>(() => loadChoices(storage));
  const [requested, setRequested] = useState(props.project);
  const project = pickProject(projects, requested, choices.project, filter);
  const projectName = project === undefined ? undefined : name(project);
  const [baseChoice, setBase] = useState<WorktreeBase | string | undefined>(props.base);
  const [environment, setEnvironment] = useState(false);
  const environmentId = useId();
  const page = useRef<HTMLDivElement>(null);
  const { create, error } = useCreateThread();
  useEffect(() => whenIdle(() => void preloadComposerParts()), []);

  // Until the starting provider is known, show models loading rather than a provider to undo.
  const start = useStartingProvider();
  const catalog = useNewThreadOptions();
  const options = start.loaded ? catalog : undefined;
  const [picked, setPicked] = useState<ProviderKind>();
  const resolved = resolve(options, choices, picked ?? start.provider);
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

  // Approvals start at the daemon's default for the project; a choice here applies to this
  // thread only and isn't remembered, so full access is never carried into the next thread.
  // A mode the provider can't run in (Ask on Cursor) is never sent: its fallback is, said so.
  const [permission, setPermission] = useState<PermissionMode>();
  const [defaultMode] = useDaemonSetting(
    "permissions.defaultMode",
    project ? { workspaceId: WorkspaceId.parse(project) } : {},
  );
  const permissions = usePermissionCapabilities(provider);
  const admitted = permissionAdmission(
    permissions.capabilities,
    permission ?? defaultMode,
    provider ? providerNames[provider] : "This provider",
  );
  const chosen = admitted.fallback ? admitted.mode : permission;

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
    if (!project || !resolved.model) return false;
    choose({ project });
    const draftId = scope.draftId;
    // The new thread takes the draft scope over: keep it when this page closes, which is now.
    scope.adopt();
    // Its first bubble shows the files as they were attached, until the daemon echoes them.
    void draft.files.settled.then((ready) => rememberAttachments(draft.files.local, ready));
    return create({
      project,
      scope: resolved.model.scope,
      model: resolved.model.id,
      mode: resolved.mode,
      base,
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
  };

  const closeEnvironment = () => {
    setEnvironment(false);
    page.current?.querySelector("textarea")?.focus();
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
      <div
        ref={page}
        className="flex h-full flex-col justify-center overflow-y-auto px-5 pt-8 pb-[12vh] sm:px-8"
      >
        <div className="mx-auto w-full max-w-(--column)">
          <h2
            aria-label={`What should we work on${projectName ? ` in ${projectName}` : ""}?`}
            className="mb-5 px-1 text-2xl font-semibold tracking-title text-foreground"
          >
            What should we work on in{" "}
            <ProjectPicker
              projects={projects}
              projectName={name}
              project={project}
              onProject={(next) => {
                setRequested(next);
                setBase(undefined);
                choose({ project: next });
              }}
            />
            ?
          </h2>
          <Composer
            thread={draftThread}
            draftKey={project ? `new:${project}` : undefined}
            busy={false}
            onSubmit={send}
            autoFocus
            placeholder="Describe the change, a bug, or a question. @ to mention a file"
            attached={
              environment ? (
                <Suspense fallback={null}>
                  <DeferredEnvironmentCard.Component
                    id={environmentId}
                    mode={resolved.mode}
                    onMode={(mode) => {
                      choose({ mode });
                      if (mode === "local") closeEnvironment();
                    }}
                    branches={branches}
                    base={base}
                    onBase={(next) => {
                      setBase(next);
                      closeEnvironment();
                    }}
                    onClose={closeEnvironment}
                  />
                </Suspense>
              ) : undefined
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
              <>
                <EnvironmentPill
                  place={resolved.mode}
                  detail={resolved.mode === "worktree" && base ? baseName(base) : undefined}
                  open={environment}
                  controls={environmentId}
                  onToggle={() => setEnvironment(!environment)}
                />
                <PermissionPicker
                  mode={admitted.mode}
                  capabilities={permissions.capabilities}
                  provider={provider}
                  loading={!!provider && (permissions.loading || defaultMode === undefined)}
                  unavailable={
                    permissions.failed
                      ? "The daemon couldn't say what this provider can gate"
                      : undefined
                  }
                  inherited={!chosen}
                  fallback={admitted.fallback}
                  onChange={(mode) => setPermission(mode ?? undefined)}
                />
              </>
            }
          />
          <SignInNotice provider={provider} />
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
