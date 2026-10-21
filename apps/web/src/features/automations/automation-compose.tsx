import type { Automation } from "@ace/protocol";
import { useConnectionState } from "@ace/client-react";
import { ClockIcon } from "@phosphor-icons/react";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { ProjectPicker } from "@/features/home/index.ts";
import { ProjectsEmptyState } from "@/features/projects/index.ts";
import { Screen } from "@/features/shell/index.ts";
import {
  Composer,
  composerEnvironmentRow,
  composerEnvironmentSurface,
  composerStrip,
  readingColumn,
  writeDraft,
} from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectMetadata, useRegisteredProjects } from "@/lib/projects.ts";
import {
  AutomationForm,
  automationFromForm,
  blankForm,
  formFromAutomation,
  titleFromPrompt,
} from "./automation-values.ts";
import type { AutomationEntry } from "@/features/automation-data/index.ts";
import { DiscardDialog } from "./discard-dialog.tsx";
import { ideas, type Idea } from "./ideas.ts";
import { AutomationAccess, AutomationModelChip, useShownModel } from "./run-settings.tsx";
import { normalizeDaemonKey } from "@/features/automation-data/index.ts";
import { localTimeZone } from "@/features/automation-schedule/index.ts";
import { useAutomation, useAutomationActions } from "@/features/automation-data/index.ts";
import { fieldErrors, whenFields, WhenPopover } from "./when-popover.tsx";

const newDraftKey = "automation-new";

/**
 * /automations/new, laid out like New thread: "What should run on its own in <project>?", the
 * strip with when it runs and whether it gets a worktree, the composer with the prompt, access
 * and the model chip, and ideas that fill it. Sending creates the automation; its name comes from
 * the prompt.
 */
export function NewAutomationScreen() {
  const { ids: projects, loaded } = useRegisteredProjects();
  if (!loaded)
    return (
      <Screen title="New automation">
        <ComposeSkeleton />
      </Screen>
    );
  if (!projects.length || !projects[0])
    return (
      <Screen title="New automation">
        <ProjectsEmptyState />
      </Screen>
    );
  return <ComposeAutomation initial={blankForm(projects[0], localTimeZone())} />;
}

/** /automations/$id/edit: the same screen over an existing automation. */
export function EditAutomationScreen(props: { id: string }) {
  const { url } = useDaemonConnection();
  return <EditSession key={`${normalizeDaemonKey(url)}:${props.id}`} id={props.id} />;
}

function EditSession(props: { id: string }) {
  const { entry, pending, error, retry } = useAutomation(props.id);
  // The definition and its revision stay together for the lifetime of this edit.
  const [previous, setPrevious] = useState<AutomationEntry | undefined>(entry);
  if (!previous && entry) setPrevious(entry);
  if (!previous)
    return (
      <Screen title="Edit automation">
        {pending ? (
          <ComposeSkeleton />
        ) : (
          <EmptyState
            icon={ClockIcon}
            title={error ? "Couldn't load this automation" : "Automation not found"}
            description={
              error
                ? "Couldn't connect. This loads again when the connection is back."
                : "It may have been deleted on another device."
            }
            action={
              error ? (
                <Button size="sm" onClick={retry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        )}
      </Screen>
    );
  return (
    <ComposeAutomation
      initial={formFromAutomation(previous.automation, localTimeZone())}
      previous={previous}
      onConflict={retry}
    />
  );
}

function ComposeSkeleton() {
  return (
    <div className={cn(readingColumn, "pt-[clamp(1rem,22vh,12rem)]")}>
      <LoadingRegion label="automation" className="flex flex-col items-center gap-6">
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </LoadingRegion>
    </div>
  );
}

function ComposeAutomation(props: {
  initial: AutomationForm;
  previous?: AutomationEntry | undefined;
  onConflict?: (() => void) | undefined;
}) {
  const { storage } = useLayout();
  const navigate = useNavigate();
  const { save } = useAutomationActions();
  const ready = useConnectionState() === "ready";
  const { ids: projects, name } = useRegisteredProjects();
  const previous = props.previous;
  const editing = previous !== undefined;
  const [form, setForm] = useState(props.initial);
  const projectDefaults = useProjectMetadata()(form.workspace)?.defaults;
  // A new automation takes the project's worktree default until the person picks.
  const [pickedWorktree, setPickedWorktree] = useState(editing);
  const worktree = pickedWorktree ? form.worktree : (projectDefaults?.worktree ?? form.worktree);
  const [touched, setTouched] = useState<ReadonlySet<keyof AutomationForm>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [whenOpen, setWhenOpen] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [composerKey, setComposerKey] = useState(0);
  const [prompt, setPrompt] = useState(props.initial.prompt);
  const committed = useRef(false);
  // The unsent prompt is kept per automation (and one for a new one) until it's saved.
  const draftKey = previous ? `automation-edit:${previous.automation.id}` : newDraftKey;
  const page = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const shownModel = useShownModel(form);
  const modelFields = shownModel ?? {
    provider: form.provider,
    model: form.model || undefined,
    effort: form.effort,
    instance: form.instance,
  };
  const all = fieldErrors({ ...form, worktree });
  const errors = Object.fromEntries(
    Object.entries(all).filter(([field]) => showAll || touched.has(field as keyof AutomationForm)),
  );
  const change = (patch: Partial<AutomationForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setTouched(
      (current) => new Set([...current, ...(Object.keys(patch) as (keyof AutomationForm)[])]),
    );
  };
  const messageField = () =>
    page.current?.querySelector<HTMLElement>('[role="combobox"][contenteditable]') ?? null;

  // Editing: leaving with unsaved changes asks first; a new automation's prompt is kept as a draft.
  const changed =
    editing &&
    (prompt.trim() !== props.initial.prompt.trim() ||
      JSON.stringify({ ...form, prompt: "" }) !== JSON.stringify({ ...props.initial, prompt: "" }));
  const blocker = useBlocker({
    shouldBlockFn: () => changed && !committed.current,
    withResolver: true,
  });
  useEffect(() => {
    if (!changed) return;
    const confirmLeave = (event: BeforeUnloadEvent) => {
      if (!committed.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", confirmLeave);
    return () => window.removeEventListener("beforeunload", confirmLeave);
  }, [changed]);

  const thread = useMemo(
    () => ({
      id: "",
      workspaceId: form.workspace,
      title: "",
      draft: true,
      provider: modelFields.provider,
      instanceId: modelFields.instance,
    }),
    [form.workspace, modelFields.provider, modelFields.instance],
  );

  const applyIdea = (idea: Idea) => {
    writeDraft(storage, newDraftKey, { text: idea.prompt, mentions: [], attachments: [] });
    setPrompt(idea.prompt);
    setComposerKey((key) => key + 1);
    change(idea.when);
    if (idea.when.trigger === "github") setWhenOpen(true);
  };

  const submit = async (text: string): Promise<boolean> => {
    setSaveError(undefined);
    const values: AutomationForm = {
      ...form,
      worktree,
      prompt: text,
      title: previous ? previous.automation.title : titleFromPrompt(text),
      provider: modelFields.provider,
      model: modelFields.model ?? "",
      effort: modelFields.effort,
      instance: modelFields.instance,
    };
    const parsed = AutomationForm.safeParse(values);
    if (!parsed.success) {
      setShowAll(true);
      if (
        parsed.error.issues.some((issue) => whenFields.has(issue.path[0] as keyof AutomationForm))
      )
        setWhenOpen(true);
      else setSaveError(parsed.error.issues[0]?.message);
      return false;
    }
    const automation: Automation = automationFromForm(parsed.data, {
      id: previous?.automation.id ?? `auto-${crypto.randomUUID()}`,
      now: Date.now(),
      previous: previous?.automation,
    });
    try {
      await save(automation, previous ? previous.revision : null);
    } catch (error) {
      props.onConflict?.();
      setSaveError(
        error instanceof Error
          ? error.message
          : "Couldn't save the automation. Check it and try again.",
      );
      return false;
    }
    committed.current = true;
    writeDraft(storage, draftKey, undefined);
    await navigate({
      to: "/automations/$automationId",
      params: { automationId: automation.id },
    });
    return true;
  };

  const blocked = !ready
    ? `Reconnect to ${editing ? "save" : "create"} this automation.`
    : undefined;
  return (
    <Screen title={editing ? "Edit automation" : "New automation"}>
      <div
        ref={page}
        className="flex h-full min-h-0 flex-col overflow-y-auto pt-6 pb-[max(1rem,env(safe-area-inset-bottom))] [scrollbar-gutter:stable]"
      >
        <div className={cn(readingColumn, "flex flex-col pt-[clamp(1rem,22vh,12rem)]")}>
          <h2 className="mb-6 px-1 text-center text-2xl leading-tight font-normal tracking-title text-balance break-words text-muted-foreground">
            What should run on its own in{" "}
            <ProjectPicker
              projects={[...new Set([form.workspace, ...projects])]}
              projectName={name}
              project={form.workspace}
              onProject={(workspace) => change({ workspace })}
              returnFocus={messageField}
            />
            ?
          </h2>
          <div className="shrink-0">
            <Composer
              key={composerKey}
              thread={thread}
              draftKey={draftKey}
              initialText={props.initial.prompt || undefined}
              busy={false}
              autoFocus
              label="What the agent does each time"
              placeholder="Describe what the agent does each time"
              shortPlaceholder="What it does each time"
              sendBlocked={blocked ? { reason: blocked, describedBy: reasonId } : undefined}
              onDraftChange={(draft) => setPrompt(draft.text)}
              onSubmit={async (draft) => {
                if (draft.files.local.length) {
                  setSaveError("An automation's prompt is text only. Remove the files to save it.");
                  return false;
                }
                return submit(draft.text.trim());
              }}
              environment={
                <div className={composerEnvironmentSurface}>
                  {saveError && (
                    <p role="alert" className="px-3 pt-2.5 pb-1 text-ui text-status-failed">
                      {saveError}
                    </p>
                  )}
                  <div className={composerEnvironmentRow}>
                    <section
                      aria-label="When and where it runs"
                      className="flex min-w-0 flex-1 items-center gap-0.5 text-xs text-muted-foreground"
                    >
                      <WhenPopover
                        form={form}
                        onChange={change}
                        errors={errors}
                        open={whenOpen}
                        onOpenChange={setWhenOpen}
                        returnFocus={messageField}
                      />
                      <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
                      <label className={cn(composerStrip, "shrink-0 cursor-default")}>
                        <span>Worktree</span>
                        <Checkbox
                          checked={worktree}
                          onCheckedChange={(checked) => {
                            setPickedWorktree(true);
                            change({ worktree: checked });
                          }}
                        />
                      </label>
                    </section>
                  </div>
                </div>
              }
              controls={
                <AutomationAccess
                  fields={{ ...modelFields, workspace: form.workspace, access: form.access }}
                  onChange={(access) => change({ access })}
                />
              }
              trailing={
                <AutomationModelChip
                  fields={modelFields}
                  onChange={(fields) =>
                    change({
                      provider: fields.provider,
                      model: fields.model ?? "",
                      effort: fields.effort,
                      instance: fields.instance,
                    })
                  }
                />
              }
            />
            {blocked && (
              <p id={reasonId} className="sr-only">
                {blocked}
              </p>
            )}
          </div>
          {!editing && (
            <section aria-label="Ideas" className="mt-8">
              <h3 className="px-1 pb-1.5 text-xs text-muted-foreground">Ideas</h3>
              <ul className="flex flex-col">
                {ideas.map((idea) => (
                  <li key={idea.prompt}>
                    <button
                      type="button"
                      onClick={() => applyIdea(idea)}
                      className="flex min-h-9 w-full items-center gap-3 rounded-md px-2 text-left text-ui transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset"
                    >
                      <span className="min-w-0 flex-1 truncate">{idea.prompt}</span>
                      <span className="shrink-0 text-xs text-subtle-foreground">{idea.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <DiscardDialog
        open={blocker.status === "blocked"}
        onKeep={() => blocker.reset?.()}
        onDiscard={() => {
          writeDraft(storage, draftKey, undefined);
          blocker.proceed?.();
        }}
      />
    </Screen>
  );
}
