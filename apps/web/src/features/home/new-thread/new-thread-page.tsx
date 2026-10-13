import { useIssueSource, usePrSource } from "@/features/forge/index.ts";
import { useNavigate } from "@tanstack/react-router";
import { ProjectPastSessions } from "@/features/history/index.ts";
import { ProjectPicker } from "./project-picker.tsx";
import type { BranchRef, PermissionMode, ProviderKind, WorktreeBase } from "@ace/protocol";
import { Suspense, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import {
  Composer,
  PermissionPicker,
  preloadComposerParts,
  readingColumn,
  rememberAttachments,
  readDraft,
  writeDraft,
  useDraftScope,
  usePermissionModes,
  type Draft,
  type ComposerHandle,
  composerEnvironmentRow,
  composerEnvironmentSurface,
} from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { whenIdle } from "@/lib/idle.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectMetadata, useRegisteredProjects } from "@/lib/projects.ts";
import { useStartingProvider } from "@/lib/provider-statuses.ts";
import { ProjectsEmptyState } from "@/features/projects/index.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
import { WorkspaceId } from "@ace/protocol";
import {
  defaultWorktreeBase,
  permissionUnavailable,
  permissionCoverage,
  permissionOption,
  permissionOptions,
  providerNames,
  speedOption,
} from "@ace/ui-core";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import {
  completePreparationChoices,
  shownPreparationChoices,
  loadChoices,
  pickProject,
  projectBaseBranch,
  resolve,
  saveChoices,
  withProjectDefaults,
  type Choices,
} from "./choices.ts";
import { ModelPicker } from "./model-picker.tsx";
import { useBaseRefs } from "@/lib/branches.ts";
import { useNewThreadOptions } from "@/features/models/index.ts";
import { useCreateThread } from "./use-create-thread.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import {
  preparation,
  preparationSaveFailed,
  retirePreparationScope,
  retainPromotedPreparation,
  preparationKey,
  savePreparation,
  type Preparation,
  usePreparationsChanged,
} from "./preparations.ts";
import { UnavailablePreparation } from "./unavailable-preparation.tsx";
import { ReturnedStartNotice } from "./returned-start-notice.tsx";
import { forgetReturnedStart, readReturnedStart } from "@/lib/returned-start.ts";
import { discardPreparation } from "./discard-preparation.ts";
import { Button } from "@/components/ui/button.tsx";
import { SignInNotice } from "@/features/sign-in/index.ts";

/** Where the thread runs: the composer's top strip, while no notice takes it. */
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

/** What a draft holds for the person: its words and files. */
function draftText(draft: { text: string; attachments: readonly unknown[] } | undefined): string {
  return JSON.stringify([draft?.text ?? "", draft?.attachments ?? []]);
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
  issue?: string | undefined;
}) {
  const { storage } = useLayout();
  const { project: filter } = useOrganizerState();
  const { ids: projects, loaded } = useRegisteredProjects();
  const host = useHostIdentity()?.hostId;
  const navigate = useNavigate();
  const project =
    props.project ?? pickProject(projects, undefined, loadChoices(storage).project, filter);
  if (!loaded || !host)
    return (
      <Screen title="New thread">
        <p role="status" className="px-5 py-6 text-sm text-muted-foreground">
          Loading projects…
        </p>
      </Screen>
    );
  if (props.project && !projects.includes(props.project))
    return (
      <UnavailablePreparation
        host={host}
        project={props.project}
        skill={props.skill}
        pullRequest={props.pullRequest}
        issue={props.issue}
      />
    );
  if (!projects.length || !project)
    return (
      <Screen title="New thread">
        <ProjectsEmptyState />
      </Screen>
    );
  return (
    <PreparationPage
      key={preparationKey(host, project, props.skill, props.issue ?? props.pullRequest)}
      {...props}
      host={host}
      project={project}
      onProject={(next) => {
        saveChoices(storage, { ...loadChoices(storage), project: next });
        void navigate({
          to: "/new",
          search: {
            project: next,
            skill: props.skill,
            pullRequest: props.pullRequest,
            issue: props.issue,
          },
        });
      }}
    />
  );
}

function PreparationPage(props: {
  host: string;
  project: string;
  base?: string | undefined;
  skill?: string | undefined;
  pullRequest?: string | undefined;
  issue?: string | undefined;
  onProject(project: string): void;
}) {
  // Kept out of the compiler: the page reads saved preparations and drafts from storage while
  // rendering, by version (`usePreparationsChanged`), and a memoized read would show stale rows.
  "use no memo";
  const { storage } = useLayout();
  const readinessId = useId();
  const { ids: projects, name, loaded } = useRegisteredProjects();
  usePreparationsChanged();
  const project = props.project;
  const prSource = usePrSource(project, props.pullRequest);
  const issueSource = useIssueSource(project, props.issue);
  const draftKey = preparationKey(
    props.host,
    project,
    props.skill,
    props.issue ?? props.pullRequest,
  );
  const [restored] = useState<Preparation | undefined>(() => {
    const previous = preparation(storage, props.host, draftKey);
    if (previous?.discardRecovery) {
      if (readDraft(storage, draftKey) || writeDraft(storage, draftKey, previous.discardRecovery))
        savePreparation(storage, props.host, draftKey, { ...previous, discardRecovery: undefined });
    }
    return previous;
  });
  const [initialChoices] = useState<Choices>(() => restored?.choices ?? loadChoices(storage));
  const [preserveSourceDraft, setPreserveSourceDraft] = useState(
    () => readDraft(storage, draftKey) !== undefined,
  );
  const awaitingSource =
    !!(props.pullRequest || props.issue) && !prSource.selection && !issueSource.ref;
  const [selection, setChoices] = useState<Choices | undefined>(undefined);
  const projectDefaults = useProjectMetadata()(project ?? "")?.defaults;
  const catalog = useNewThreadOptions();
  const choices =
    selection ??
    preparation(storage, props.host, draftKey)?.choices ??
    withProjectDefaults(initialChoices, projectDefaults, catalog?.models);
  const [baseChoice, setBase] = useState<WorktreeBase | string | undefined>(
    props.base ?? restored?.base,
  );
  const [editorOwner] = useState(() => crypto.randomUUID());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const saved = preparation(storage, props.host, draftKey);
    if (saved) savePreparation(storage, props.host, draftKey, { ...saved, owner: editorOwner });
    return () => {
      mounted.current = false;
    };
  }, [storage, props.host, draftKey, editorOwner]);
  const scopeId = useRef(restored?.draftId);
  const latestContent = useRef(readDraft(storage, draftKey));
  const [opened] = useState(() => draftText(readDraft(storage, draftKey)));
  const editedHere = useRef(false);
  const submitting = useRef(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // Why the last start from here came back, until it is sent again or dismissed.
  const [returned, setReturned] = useState(() => readReturnedStart(storage, draftKey));
  const forgetReturned = () => {
    forgetReturnedStart(storage, draftKey);
    setReturned(undefined);
  };
  const contentSaveRefused = useRef(false);
  const metadataSaveRefused = useRef(false);
  const page = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  useEffect(() => whenIdle(() => void preloadComposerParts()), []);

  // Until the starting provider is known, show models loading rather than a provider to undo.
  const start = useStartingProvider();
  const options = start.loaded ? catalog : undefined;
  const [picked, setPicked] = useState<ProviderKind | undefined>(restored?.provider);
  const [useWorktree] = useDaemonSetting("threads.useWorktree");
  const selected = resolve(
    options,
    choices,
    picked ?? projectDefaults?.provider ?? start.provider,
    useWorktree === false ? "local" : "worktree",
  );
  const resolved = props.pullRequest ? { ...selected, mode: "worktree" as const } : selected;
  const branches = useBaseRefs(project);
  // The base picked here, else the one asked for by name (a local branch until the branches
  // say otherwise), else the default branch at its freshest; undefined while the branches load
  // (the daemon then starts from HEAD).
  const savedBase = baseChoice ?? preparation(storage, props.host, draftKey)?.base;
  const base =
    typeof savedBase === "object"
      ? savedBase
      : savedBase !== undefined
        ? namedBase(savedBase, branches.refs)
        : defaultWorktreeBase(
            branches.refs,
            projectBaseBranch(projectDefaults, branches.refs) ?? branches.defaultBranch,
          );
  const provider = resolved.provider;

  // An explicit choice holds across account and provider changes, shown as unavailable where
  // the new one doesn't offer it, until the person replaces it; null is an explicit reset to
  // the provider's default. Omission retains the configured native default (ADR 0069).
  const [permission, setPermissionState] = useState<PermissionMode | null | undefined>(
    restored?.permission,
  );
  const setPermission = (id: PermissionMode | null) => {
    setPermissionState(id);
    remember({ permission: id ?? undefined });
  };
  const [defaultMode] = useDaemonSetting(
    "permissions.providerModes",
    project ? { workspaceId: WorkspaceId.parse(project) } : {},
  );
  const permissions = usePermissionModes(provider, {
    instanceId: resolved.account?.id,
    currentId: permission !== undefined ? permission : provider ? defaultMode?.[provider] : null,
    setCurrentId: setPermissionState,
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
  const chosen =
    permission && permissions.modes.some((mode) => mode.id === permission) ? permission : undefined;

  const remember = (patch: Partial<Preparation> = {}) => {
    const previous = preparation(storage, props.host, draftKey);
    const content = readDraft(storage, draftKey);
    const completed =
      previous?.settingsResolved ?? (!!previous?.provider && !!previous?.choices.model);
    const snapshot = completed ? completePreparationChoices : shownPreparationChoices;
    const saved = savePreparation(storage, props.host, draftKey, {
      project,
      owner: editorOwner,
      skill: props.skill,
      pullRequest: props.pullRequest,
      issue: props.issue,
      choices: { ...snapshot(selection ?? previous?.choices ?? choices, resolved), project },
      settingsResolved: completed || !!resolved.model,
      provider: selection ? provider : (previous?.provider ?? provider),
      permission: permission === undefined ? previous?.permission : (permission ?? undefined),
      base: baseChoice ?? base,
      scopeEpoch: previous?.scopeEpoch,
      attachmentsUnavailable: previous?.attachmentsUnavailable && !!content?.attachments.length,
      discardRecovery: previous?.discardRecovery,
      handoffCleanupPending: previous?.handoffCleanupPending,
      // The scope this editor holds stays named while the daemon has yet to grant it again
      // (just reopened, or offline), so a reload resumes it with its files.
      draftId:
        previous?.draftId && previous.draftId !== scopeId.current && content?.attachments.length
          ? previous.draftId
          : scope.draftId === scopeId.current ||
              (scope.draftId === undefined && !claimed(scopeId.current))
            ? scopeId.current
            : undefined,
      title:
        previous?.title ?? content?.text.trim().split("\n")[0]?.slice(0, 100) ?? "New preparation",
      ...patch,
    });
    metadataSaveRefused.current = !saved;
    setSaveFailed(!saved || contentSaveRefused.current);
  };
  const choose = (patch: Partial<Choices>) => {
    const next = {
      ...choices,
      project,
      model: resolved.model?.key ?? choices.model,
      account: resolved.account?.id ?? choices.account,
      mode: resolved.mode,
      effort: resolved.effort,
      speed: resolved.speed,
      ...patch,
    };
    setChoices(next);
    saveChoices(storage, next);
    const nextProvider =
      options?.models.find((row) => row.key === next.model)?.provider ?? provider;
    remember({ choices: next, provider: nextProvider });
  };
  const chooseProject = props.onProject;
  // A model remembered as a bare id (before option keys) is saved under its option key, again
  // after any later choice saves the bare id it still holds.
  const upgraded = resolved.upgradedModel;
  useEffect(() => {
    if (upgraded !== undefined) saveChoices(storage, { ...choices, model: upgraded });
  }, [upgraded, choices, storage]);
  // Mentions, uploads and slash commands go to a draft scope on the daemon before the thread
  // exists; the new thread adopts it. A draft ref's id is that scope.
  const scope = useDraftScope(project, {
    epoch: preparation(storage, props.host, draftKey)?.scopeEpoch,
    read: () => {
      const id = preparation(storage, props.host, draftKey)?.draftId;
      return claimed(id) ? undefined : id;
    },
    granted(id) {
      scopeId.current = id;
      const saved = preparation(storage, props.host, draftKey);
      if (
        saved &&
        (!saved.draftId ||
          saved.draftId === id ||
          !readDraft(storage, draftKey)?.attachments.length)
      )
        if (!savePreparation(storage, props.host, draftKey, { ...saved, draftId: id }))
          setSaveFailed(true);
    },
    owns: (id) => preparation(storage, props.host, draftKey)?.draftId === id,
    consumed(id) {
      if (!retirePreparationScope(storage, props.host, draftKey, id)) setSaveFailed(true);
    },
  });
  // A recovered start opens its thread unless the person is writing other work in this editor.
  const recoveryMayLeave = useRef(true);
  const {
    create,
    error,
    recovering,
    claims: claimed,
  } = useCreateThread(
    (payload) => {
      const matched =
        !metadataSaveRefused.current &&
        !contentSaveRefused.current &&
        payload.workspaceId === project &&
        composer.current?.discardIfSubmitted(payload);
      recoveryMayLeave.current = !!matched || !editedHere.current;
      if (payload.context?.draftId) {
        scope.retire(payload.context.draftId);
        if (payload.workspaceId === project) {
          if (matched && !discardPreparation(storage, props.host, draftKey)) {
            if (!retainPromotedPreparation(storage, props.host, draftKey, payload.context.draftId))
              setSaveFailed(true);
          } else if (
            !matched &&
            !retirePreparationScope(storage, props.host, draftKey, payload.context.draftId)
          )
            setSaveFailed(true);
        }
      }
    },
    () =>
      recoveryMayLeave.current &&
      !contentSaveRefused.current &&
      !metadataSaveRefused.current &&
      !preparationSaveFailed(storage, draftKey),
  );
  const settlePreparation = useEffectEvent(() => {
    const saved = preparation(storage, props.host, draftKey);
    if (!saved || !resolved.model) return;
    const completed = saved.settingsResolved ?? (!!saved.provider && !!saved.choices.model);
    const snapshot = completed ? completePreparationChoices : shownPreparationChoices;
    const next = { ...snapshot(selection ?? saved.choices, resolved), project };
    if (
      !saved.provider ||
      !saved.settingsResolved ||
      JSON.stringify(next) !== JSON.stringify(saved.choices)
    ) {
      savePreparation(storage, props.host, draftKey, {
        ...saved,
        choices: next,
        settingsResolved: true,
        provider: selection ? provider : (saved.provider ?? provider),
      });
    }
  });
  const settledSettings = resolved.model
    ? JSON.stringify([
        provider,
        resolved.model.key,
        resolved.account?.id,
        resolved.effort,
        resolved.speed,
        resolved.mode,
      ])
    : undefined;
  const settleBase = useEffectEvent(() => {
    const saved = preparation(storage, props.host, draftKey);
    if (saved && saved.base === undefined && base !== undefined)
      savePreparation(storage, props.host, draftKey, { ...saved, base });
  });
  const settledBase = branches.state === "ready" ? JSON.stringify(base) : undefined;
  useEffect(() => {
    if (settledSettings !== undefined) settlePreparation();
  }, [settledSettings]);
  useEffect(() => {
    if (settledBase !== undefined) settleBase();
  }, [settledBase]);
  const accountId = resolved.account?.id;
  const draftThread = useDraftThreadRef(scope.draftId, project, provider, accountId, scope.retry);
  const waitingForAdmission =
    !start.loaded ||
    options === undefined ||
    (!!provider && (defaultMode === undefined || permissions.loading));
  const missingSelection =
    restored &&
    options &&
    ((choices.model !== undefined &&
      !options.models.some(
        (row) => row.key === choices.model && (!choices.account || row.account === choices.account),
      )) ||
      (choices.account !== undefined &&
        !options.accounts.some((row) => row.id === choices.account)) ||
      (choices.effort !== undefined &&
        resolved.model &&
        !resolved.model.efforts?.includes(choices.effort)) ||
      (choices.speed !== undefined &&
        choices.speed !== "standard" &&
        !resolved.model?.speeds.some((tier) => tier.speed === choices.speed)));
  const missingPermission =
    permission &&
    permissions.capabilities &&
    !permissions.modes.some((mode) => mode.id === permission);
  const missingBase =
    !props.pullRequest &&
    resolved.mode === "worktree" &&
    savedBase &&
    branches.state === "ready" &&
    branches.refs.length > 0 &&
    !branches.refs.some((ref) =>
      typeof savedBase === "string"
        ? ref.name === savedBase || `${ref.remote}/${ref.name}` === savedBase
        : ref.name === savedBase.ref && ref.remote === savedBase.remote,
    );
  const savedScope = preparation(storage, props.host, draftKey)?.draftId;
  const missingFiles =
    (preparation(storage, props.host, draftKey)?.attachmentsUnavailable &&
      !!readDraft(storage, draftKey)?.attachments.length) ||
    (savedScope &&
      scope.draftId &&
      savedScope !== scope.draftId &&
      !!readDraft(storage, draftKey)?.attachments.length);
  const admissionProblem = recovering
    ? "Recovering the previous thread start…"
    : missingPermission
      ? "The saved approval mode is unavailable. Choose an available approval mode before sending."
      : missingBase
        ? "The saved base branch is unavailable. Choose an available branch before sending."
        : missingSelection
          ? "A saved model, account, or reasoning setting is unavailable. Choose an available setting before sending."
          : missingFiles
            ? "Saved attachments are unavailable. Remove and add them again before sending."
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
    if (
      !project ||
      !resolved.model ||
      admissionProblem ||
      issueSource.problem ||
      prSource.problem ||
      !scope.draftId
    )
      return false;
    submitting.current = true;
    recoveryMayLeave.current = true;
    forgetReturned();
    // ⌘N opens the project of the thread started last.
    saveChoices(storage, { ...loadChoices(storage), project });
    const submittedRevision = preparation(storage, props.host, draftKey)?.revision;
    const submittedContent = JSON.stringify(readDraft(storage, draftKey));
    const draftId = scope.draftId;
    // The new thread takes the draft scope over: keep it when this page closes, which is now.
    scope.adopt();
    // Its first bubble shows the files as they were attached, until the daemon echoes them.
    void draft.files.settled.then((ready) => rememberAttachments(draft.files.local, ready));
    const sent = await create({
      project,
      draftKey,
      pullRequest: prSource.selection,
      issue: issueSource.ref,
      scope: resolved.model.scope,
      model: resolved.model.id,
      mode: resolved.mode,
      base,
      effort: resolved.effort,
      serviceTier: speedOption(resolved.model.speeds, resolved.speed),
      permission: chosen,
      input: draft.input,
      text: draft.text,
      context: {
        ...(draftId ? { draftId } : {}),
        items: draft.threadRefs,
        mentions: draft.mentions,
        attachments: draft.attachments,
      },
    });
    submitting.current = false;
    const current = preparation(storage, props.host, draftKey);
    const content = readDraft(storage, draftKey);
    const unchanged =
      current?.owner === editorOwner &&
      current.revision === submittedRevision &&
      (JSON.stringify(content) === submittedContent || !content);
    if (
      sent &&
      unchanged &&
      !contentSaveRefused.current &&
      !metadataSaveRefused.current &&
      !preparationSaveFailed(storage, draftKey) &&
      (!mounted.current ||
        (!latestContent.current?.text.trim() && !latestContent.current?.attachments.length))
    ) {
      scope.retire(draftId);
      if (!discardPreparation(storage, props.host, draftKey)) {
        const retired = retainPromotedPreparation(storage, props.host, draftKey, draftId);
        if (mounted.current)
          setSaveFailed(
            !retired || preparation(storage, props.host, draftKey)?.handoffCleanupPending === true,
          );
      }
    } else if (sent && current?.draftId === draftId) {
      // The handoff consumed this scope. Retained content now owns a new preparation.
      scope.retire(draftId);
      const retired = retirePreparationScope(storage, props.host, draftKey, draftId);
      if (mounted.current)
        setSaveFailed(!retired || contentSaveRefused.current || metadataSaveRefused.current);
      if (mounted.current) scopeId.current = undefined;
    } else if (sent) {
      scope.retire(draftId);
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
  const recoverable =
    readDraft(storage, draftKey) ?? preparation(storage, props.host, draftKey)?.discardRecovery;
  const promoted = preparation(storage, props.host, draftKey)?.handoffCleanupPending;
  if (promoted || (recoverable && !readDraft(storage, draftKey)))
    return (
      <Screen title="Saved preparation">
        <div className="px-5 py-6">
          <p role="alert" className="text-ui text-status-failed">
            {promoted
              ? "The thread was saved, but its preparation couldn't be removed. Discard this recovery copy when this device has free space."
              : "Couldn't restore this saved preparation in the editor. Free space or discard an older draft, then reopen it."}
          </p>
          <pre aria-label="Saved message" className="mt-4 whitespace-pre-wrap text-ui">
            {recoverable?.text ?? ""}
          </pre>
          <ul aria-label="Saved attachments" className="mt-3 text-ui">
            {recoverable?.attachments.map((file) => (
              <li key={`${file.sha256}:${file.name}`}>{file.name}</li>
            ))}
          </ul>
        </div>
      </Screen>
    );
  return (
    <Screen title="New thread">
      <div
        ref={page}
        className="flex h-full min-h-0 flex-col overflow-y-auto pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {/* The thread's reading column: the composer keeps its place and width when Enter
            opens the thread. */}
        <div className={cn(readingColumn, "flex h-full min-h-0 flex-col")}>
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
            {/* Past sessions sit under the question, never below the composer. */}
            <div className="w-full shrink-0 px-2 pb-4 text-left">
              <ProjectPastSessions projectId={project} />
            </div>
          </div>
          <div className="shrink-0">
            <Composer
              ref={composer}
              key={`${project}:${JSON.stringify(preserveSourceDraft ? null : (prSource.selection?.ref ?? issueSource.ref ?? null))}`}
              onPlan={() => {
                if (provider === "claude") setPermission("plan");
              }}
              thread={draftThread}
              draftKey={draftKey}
              keepsAttachments
              ownsDraft={() => {
                const current = preparation(storage, props.host, draftKey);
                return !current || current.owner === editorOwner;
              }}
              onFilesAdded={() => {
                if (awaitingSource) setPreserveSourceDraft(true);
                remember({ title: "Attached files" });
              }}
              onDraftChange={(content) => {
                latestContent.current = content;
                if (draftText(content) !== opened) editedHere.current = true;
                // Preserve edits made while metadata loads, including unsaved storage refusals.
                if (awaitingSource && (content.text.length || content.attachments.length))
                  setPreserveSourceDraft(true);
                if (
                  (!submitting.current || content.text.trim() || content.attachments.length) &&
                  !writeDraft(storage, draftKey, content)
                ) {
                  contentSaveRefused.current = true;
                  setSaveFailed(true);
                  return;
                }
                contentSaveRefused.current = false;
                if (!content.text.trim() && !content.attachments.length) {
                  if (!submitting.current && preparation(storage, props.host, draftKey))
                    remember({ title: "New preparation" });
                  return;
                }
                remember({
                  title: content.text.trim().split("\n")[0]?.slice(0, 100) || "Attached files",
                });
              }}
              initialText={
                prSource.text ?? issueSource.text ?? (props.skill ? `/${props.skill} ` : undefined)
              }
              busy={false}
              sendBlocked={
                admissionProblem || issueSource.problem || prSource.problem
                  ? {
                      reason: admissionProblem || issueSource.problem || prSource.problem || "",
                      describedBy: readinessId,
                    }
                  : undefined
              }
              onSubmit={send}
              autoFocus
              placeholder="Describe the change, a bug, or a question. @ to mention a file"
              shortPlaceholder="Describe a task"
              // Nothing renders below the composer. Its one strip above shows where the thread
              // runs; a notice takes the strip's place while there is one. Sign-in decides for
              // itself whether it shows, so the row steps aside for it in CSS.
              environment={
                <div
                  className={cn(
                    composerEnvironmentSurface,
                    "[&:has([data-notices]:not(:empty))_[data-environment]]:hidden",
                  )}
                >
                  <div
                    data-notices=""
                    className="flex flex-col gap-2 px-3 pt-2.5 pb-1 empty:hidden"
                  >
                    {(admissionProblem || issueSource.problem || prSource.problem) && (
                      <p id={readinessId} role="status" className="text-xs text-muted-foreground">
                        {admissionProblem || issueSource.problem || prSource.problem}
                      </p>
                    )}
                    <SignInNotice provider={provider} />
                    {(saveFailed || preparationSaveFailed(storage, draftKey)) && (
                      <div role="alert" className="text-ui text-status-failed">
                        <p>
                          Couldn't save this preparation on this device. Keep this page open and
                          free space or discard an older draft before leaving.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const content = latestContent.current;
                            if (!content || !writeDraft(storage, draftKey, content)) {
                              contentSaveRefused.current = true;
                              setSaveFailed(true);
                              return;
                            }
                            contentSaveRefused.current = false;
                            remember({
                              title:
                                content.text.trim().split("\n")[0]?.slice(0, 100) ||
                                "New preparation",
                            });
                          }}
                        >
                          Save draft
                        </Button>
                      </div>
                    )}
                    {error && (
                      <p role="alert" className="text-ui text-status-failed">
                        {error}
                      </p>
                    )}
                    {returned && !error && (
                      <ReturnedStartNotice
                        reason={returned}
                        worktree={resolved.mode === "worktree" && !props.pullRequest}
                        onLocal={() => {
                          choose({ mode: "local" });
                          forgetReturned();
                          toMessage();
                        }}
                        onDismiss={() => {
                          forgetReturned();
                          toMessage();
                        }}
                      />
                    )}
                  </div>
                  {!(
                    admissionProblem ||
                    issueSource.problem ||
                    prSource.problem ||
                    saveFailed ||
                    preparationSaveFailed(storage, draftKey) ||
                    error ||
                    returned
                  ) && (
                    <div data-environment="" className={composerEnvironmentRow}>
                      <Suspense fallback={null}>
                        <DeferredEnvironment.Component
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
                            remember({ base: next });
                            toMessage();
                          }}
                        />
                      </Suspense>
                    </div>
                  )}
                </div>
              }
              trailing={
                <ModelPicker
                  options={options}
                  resolved={resolved}
                  unconfirmed={!!missingSelection}
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
                      speed: undefined,
                    });
                  }}
                  onAccount={(account) => choose({ account })}
                  onEffort={(effort) => choose({ effort })}
                  onSpeed={(speed) => choose({ speed })}
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
                  onChange={(id) => setPermission(id ?? null)}
                />
              }
            />
          </div>
        </div>
      </div>
    </Screen>
  );
}
