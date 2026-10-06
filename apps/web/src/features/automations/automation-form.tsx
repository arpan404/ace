import { ProviderKind } from "@ace/protocol";
import { useStore } from "@tanstack/react-form";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useModelChoices } from "@/features/models/index.ts";
import { choiceLine, modelLabel, providerNames } from "@ace/ui-core";
import { AutomationForm } from "./automation-values.ts";
import { missedRunLabels } from "./labels.ts";
import { Row, invalidProps, visible } from "./form-row.tsx";
import { ScheduleFields } from "./schedule-fields.tsx";
import { useAutomationForm, type AutomationFormApi } from "./use-automation-form.ts";
import { githubEventLabels } from "./schedule.ts";

const providers = ProviderKind.options.map((value) => ({ value, label: providerNames[value] }));
const triggerOptions = {
  schedule: { value: "schedule", label: "On a schedule" },
  github: { value: "github", label: "On a GitHub event" },
  file: { value: "file", label: "On file change" },
  manual: { value: "manual", label: "By hand" },
} as const;
const events = AutomationForm.shape.event.options.map((value) => ({
  value,
  label: `When ${githubEventLabels[value]}`,
}));
const missed = (["run_once", "skip"] as const).map((value) => ({
  value,
  label: missedRunLabels[value],
}));
/** The Model select's "no model": the agent picks its own default. */
const agentDefault = ":default";

/**
 * Create or edit an automation. Validated with the same Zod schema on every change; errors
 * show once a field has been touched or a save was attempted, and a failed save moves focus
 * to the first field that needs fixing. Leaving with unsaved changes asks first.
 */
export function AutomationEditor(props: {
  initial: AutomationForm;
  workspaces: readonly string[];
  /** A project's name by id. */
  workspaceName(id: string): string;
  submitLabel: string;
  /** Editing: Save stays off until something changed. */
  requireChanges?: boolean;
  cancel: ReactNode;
  /**
   * Saves the form. Call `committed()` once the daemon has stored it: from then on leaving
   * isn't guarded, so the save's own navigation goes through.
   */
  onSave(form: AutomationForm, committed: () => void): Promise<void>;
}) {
  const choices = useModelChoices();
  const [saveError, setSaveError] = useState<string>();
  // Set only once the daemon has the saved definition; until then leaving still asks.
  const committed = useRef(false);
  const form = useAutomationForm(props.initial, async (value) => {
    setSaveError(undefined);
    try {
      // Older definitions stored a picker row id. Repair only catalog-proven
      // identities, preserving arbitrary provider model ids verbatim.
      const model =
        choices.find((choice) => choice.provider === value.provider && choice.id === value.model)
          ?.modelId ?? value.model;
      await props.onSave({ ...value, model }, () => {
        committed.current = true;
      });
    } catch (error) {
      committed.current = false;
      setSaveError(error instanceof Error ? error.message : "The daemon refused that.");
    }
  });
  const changed = useStore(form.store, (state) => !state.isDefaultValue);
  // While a save is under way the fields are locked, so nothing typed then is left out of it.
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const formElement = useRef<HTMLFormElement>(null);
  const blocker = useBlocker({
    shouldBlockFn: () => changed && !committed.current,
    withResolver: true,
  });
  // Closing or reloading the window: the browser's own confirmation, whatever the history.
  useEffect(() => {
    if (!changed) return;
    const confirmLeave = (event: BeforeUnloadEvent) => {
      if (committed.current) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", confirmLeave);
    return () => window.removeEventListener("beforeunload", confirmLeave);
  }, [changed]);
  const workspaceOptions = [...new Set([props.initial.workspace, ...props.workspaces])]
    .filter(Boolean)
    .map((value) => ({ value, label: props.workspaceName(value) }));
  // A file trigger can't be made here, but one made elsewhere keeps its own segment.
  const triggers = [
    triggerOptions.schedule,
    triggerOptions.github,
    ...(props.initial.trigger === "file" ? [triggerOptions.file] : []),
    triggerOptions.manual,
  ];
  return (
    <form
      ref={formElement}
      noValidate
      aria-label="Automation"
      className="@container mt-6 flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit().then(() => focusFirstInvalid(form, formElement.current));
      }}
    >
      <fieldset disabled={submitting} className="contents">
        <form.Field name="title">
          {(field) => {
            const error = visible(field.state.meta);
            return (
              <Row label="Name" htmlFor="automation-title" errors={error}>
                <Input
                  id="automation-title"
                  name="title"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onValueChange={(value) => field.handleChange(value)}
                  placeholder="Nightly dependency audit"
                  {...invalidProps("automation-title", error)}
                />
              </Row>
            );
          }}
        </form.Field>
        <form.Field name="prompt">
          {(field) => {
            const error = visible(field.state.meta);
            return (
              <Row label="What should the agent do?" htmlFor="automation-prompt" errors={error}>
                <Textarea
                  id="automation-prompt"
                  name="prompt"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Audit dependencies for advisories and open a thread with a fix for each."
                  className="min-h-28"
                  {...invalidProps("automation-prompt", error)}
                />
              </Row>
            );
          }}
        </form.Field>
        <div className="grid gap-x-4 @min-[34rem]:grid-cols-3">
          <form.Field name="workspace">
            {(field) => (
              <Row label="Project" errors={visible(field.state.meta)}>
                <Select
                  label="Project"
                  value={field.state.value}
                  options={workspaceOptions}
                  onValueChange={(value) => field.handleChange(value)}
                  className="w-full min-w-0"
                />
              </Row>
            )}
          </form.Field>
          <form.Field name="provider">
            {(field) => (
              <Row label="Agent">
                <AgentSelect
                  value={field.state.value}
                  onChange={(provider, keepsModel) => {
                    field.handleChange(provider);
                    if (!keepsModel) form.setFieldValue("model", "");
                  }}
                  currentModel={() => form.getFieldValue("model")}
                />
              </Row>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.provider}>
            {(provider) => (
              <form.Field name="model">
                {(field) => (
                  <Row label="Model">
                    <ModelSelect
                      provider={provider}
                      value={field.state.value}
                      onChange={(value) => field.handleChange(value)}
                    />
                  </Row>
                )}
              </form.Field>
            )}
          </form.Subscribe>
        </div>
        <form.Field name="trigger">
          {(field) => (
            <Row label="When it runs" className="items-start">
              <SegmentedControl
                label="When it runs"
                value={field.state.value}
                options={triggers}
                onValueChange={(value) => field.handleChange(value)}
              />
            </Row>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.trigger}>
          {(trigger) => <TriggerFields form={form} trigger={trigger} />}
        </form.Subscribe>
        <div className="mt-2 border-b">
          <form.Field name="worktree">
            {(field) => (
              <InlineRow
                title="Run in a fresh worktree"
                description="Keeps your checkout untouched. The thread shows the branch it made."
                htmlFor="automation-worktree"
              >
                <Switch
                  id="automation-worktree"
                  checked={field.state.value}
                  onCheckedChange={(checked) => field.handleChange(checked)}
                />
              </InlineRow>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.trigger === "schedule"}>
            {(scheduled) =>
              scheduled && (
                <form.Field name="missedRun">
                  {(field) => (
                    <InlineRow
                      title="If a run was missed"
                      description="When this machine was asleep or the daemon was stopped at the time."
                    >
                      <Select
                        label="If a run was missed"
                        value={field.state.value}
                        options={missed}
                        onValueChange={(value) => field.handleChange(value)}
                      />
                    </InlineRow>
                  )}
                </form.Field>
              )
            }
          </form.Subscribe>
        </div>
      </fieldset>
      {saveError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {saveError}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <span inert={submitting} className="contents">
          {props.cancel}
        </span>
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || (props.requireChanges === true && !changed)}
        >
          {props.submitLabel}
        </Button>
      </div>
      <DiscardDialog
        open={blocker.status === "blocked"}
        onKeep={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
      />
    </form>
  );
}

/** The fields under "When it runs" for the chosen trigger. */
function TriggerFields(props: { form: AutomationFormApi; trigger: AutomationForm["trigger"] }) {
  const { form } = props;
  switch (props.trigger) {
    case "schedule":
      return <ScheduleFields form={form} />;
    case "github":
      return (
        <>
          <div className="grid gap-x-4 @min-[34rem]:grid-cols-2">
            <form.Field name="repository">
              {(field) => {
                const error = visible(field.state.meta);
                return (
                  <Row label="Repository" htmlFor="automation-repo" errors={error}>
                    <Input
                      id="automation-repo"
                      name="repository"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onValueChange={(value) => field.handleChange(value)}
                      placeholder="owner/name"
                      className="font-mono"
                      {...invalidProps("automation-repo", error)}
                    />
                  </Row>
                );
              }}
            </form.Field>
            <form.Field name="event">
              {(field) => (
                <Row label="Event">
                  <Select
                    label="Event"
                    value={field.state.value}
                    options={events}
                    onValueChange={(value) => field.handleChange(value)}
                    className="w-full min-w-0"
                  />
                </Row>
              )}
            </form.Field>
          </div>
          <form.Subscribe selector={(state) => state.values.event === "issue_labelled"}>
            {(labelled) =>
              labelled && (
                <form.Field name="label">
                  {(field) => {
                    const error = visible(field.state.meta);
                    return (
                      <Row label="Label" htmlFor="automation-label" errors={error}>
                        <Input
                          id="automation-label"
                          name="label"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onValueChange={(value) => field.handleChange(value)}
                          placeholder="needs-triage"
                          {...invalidProps("automation-label", error)}
                        />
                      </Row>
                    );
                  }}
                </form.Field>
              )
            }
          </form.Subscribe>
        </>
      );
    case "file":
      return (
        <form.Field name="paths">
          {(field) => {
            const error = visible(field.state.meta);
            return (
              <Row label="Paths to watch, one per line" htmlFor="automation-paths" errors={error}>
                <Textarea
                  id="automation-paths"
                  name="paths"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="src/**/*.ts"
                  className="min-h-20 font-mono"
                  {...invalidProps("automation-paths", error)}
                />
              </Row>
            );
          }}
        </form.Field>
      );
    case "manual":
      return (
        <p className="mb-4 text-sm text-muted-foreground">
          Runs only when you press Run now. Useful for a prompt you repeat.
        </p>
      );
  }
}

/** Agent picker; says whether the chosen model still belongs to the new agent. */
function AgentSelect(props: {
  value: ProviderKind;
  currentModel(): string;
  onChange(provider: ProviderKind, keepsModel: boolean): void;
}) {
  const choices = useModelChoices();
  return (
    <Select
      label="Agent"
      value={props.value}
      options={providers}
      onValueChange={(provider) => {
        const model = props.currentModel();
        props.onChange(
          provider,
          !model ||
            choices.some((choice) => choice.provider === provider && choice.modelId === model),
        );
      }}
      className="w-full min-w-0"
    />
  );
}

/**
 * The agent's models from the catalog, by name ("Claude Code · work · Sonnet 4.5"), after
 * "Agent's default". A saved model the catalog doesn't list keeps a readable entry.
 */
function ModelSelect(props: { provider: ProviderKind; value: string; onChange(id: string): void }) {
  const choices = useModelChoices();
  const seen = new Set<string>();
  const own = choices
    .filter((choice) => choice.provider === props.provider)
    .filter((choice) => {
      if (seen.has(choice.modelId)) return false;
      seen.add(choice.modelId);
      return true;
    })
    .map((choice) => ({ value: choice.modelId, label: choiceLine(choice) }));
  const selected =
    choices.find((choice) => choice.provider === props.provider && choice.id === props.value)
      ?.modelId ?? props.value;
  const known = !selected || own.some((option) => option.value === selected);
  const options = [
    { value: agentDefault, label: "Agent's default" },
    ...own,
    ...(known
      ? []
      : [{ value: props.value, label: modelLabel(props.value.split(":").at(-1) ?? "") }]),
  ];
  return (
    <Select
      label="Model"
      value={selected || agentDefault}
      options={options}
      onValueChange={(value) => props.onChange(value === agentDefault ? "" : value)}
      className="w-full min-w-0"
    />
  );
}

/**
 * After a save that didn't validate, focus lands on the first field to fix, in page order.
 * Fields are found by their `name`, so it doesn't wait for the errors to render.
 */
function focusFirstInvalid(form: AutomationFormApi, element: HTMLFormElement | null) {
  if (!element || form.state.isValid) return;
  for (const control of element.querySelectorAll<HTMLElement>("[name]")) {
    const name = control.getAttribute("name") as keyof AutomationForm;
    if (form.getFieldMeta(name)?.errors.length) {
      control.focus();
      return;
    }
  }
}

/** Leaving with unsaved changes: keep editing (the default, and Esc) or discard them. */
function DiscardDialog(props: { open: boolean; onKeep(): void; onDiscard(): void }) {
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onKeep()}>
      <DialogContent initialFocus={keep} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Discard changes to this automation?</DialogTitle>
          <DialogDescription>What you changed here hasn't been saved.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={keep} variant="ghost" onClick={props.onKeep}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={props.onDiscard}>
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InlineRow(props: {
  title: string;
  description: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const Title = props.htmlFor ? "label" : "div";
  return (
    <div className="flex items-center gap-4 border-t py-3.5">
      <div className="min-w-0 flex-1">
        <Title
          {...(props.htmlFor ? { htmlFor: props.htmlFor } : {})}
          className="block text-ui font-medium"
        >
          {props.title}
        </Title>
        <p className="mt-0.5 text-sm text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </div>
  );
}
