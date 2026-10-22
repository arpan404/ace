import type { Automation } from "@ace/protocol";
import { useConnectionState } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useRef, useState } from "react";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { ProjectPicker } from "@/features/home/index.ts";
import { ProjectsEmptyState } from "@/features/projects/index.ts";
import { Screen } from "@/features/shell/index.ts";
import {
  Composer,
  composerEnvironmentRow,
  composerEnvironmentSurface,
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
  titleFromPrompt,
} from "./automation-values.ts";
import { ideas, type Idea } from "./ideas.ts";
import { AutomationAccess, AutomationModelChip, useShownModel } from "./run-settings.tsx";
import { localTimeZone } from "@/features/automation-schedule/index.ts";
import { useAutomationActions } from "@/features/automation-data/index.ts";
import { fieldErrors, whenFields, WhenPopover } from "./when-popover.tsx";

const newDraftKey = "automation-new";

/**
 * /automations/new, laid out like New thread: "What should run on its own in <project>?", the
 * strip with when it runs, the composer with the prompt, access
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

function ComposeAutomation(props: { initial: AutomationForm }) {
  const { storage } = useLayout();
  const navigate = useNavigate();
  const { save } = useAutomationActions();
  const ready = useConnectionState() === "ready";
  const { ids: projects, name } = useRegisteredProjects();
  const [form, setForm] = useState(props.initial);
  const projectDefaults = useProjectMetadata()(form.workspace)?.defaults;
  // Each run starts a thread the way the project starts threads: in a worktree or not.
  const worktree = projectDefaults?.worktree ?? form.worktree;
  const [touched, setTouched] = useState<ReadonlySet<keyof AutomationForm>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [whenOpen, setWhenOpen] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [composerKey, setComposerKey] = useState(0);
  // The unsent prompt is kept as a draft until it's saved.
  const draftKey = newDraftKey;
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
      title: titleFromPrompt(text),
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
      id: `auto-${crypto.randomUUID()}`,
      now: Date.now(),
    });
    try {
      await save(automation, null);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Couldn't save the automation. Check it and try again.",
      );
      return false;
    }
    writeDraft(storage, draftKey, undefined);
    await navigate({
      to: "/automations/$automationId",
      params: { automationId: automation.id },
    });
    return true;
  };

  const blocked = !ready ? "Reconnect to create this automation." : undefined;
  return (
    <Screen title="New automation">
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
        </div>
      </div>
    </Screen>
  );
}
