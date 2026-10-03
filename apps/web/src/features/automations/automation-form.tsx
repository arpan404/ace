import { ProviderKind } from "@ace/protocol";
import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { AutomationForm } from "./automation-values.ts";
import { missedRunLabels, providerLabels } from "./labels.ts";
import { Row, visible } from "./form-row.tsx";
import { ScheduleFields } from "./schedule-fields.tsx";
import { useAutomationForm } from "./use-automation-form.ts";
import { githubEventLabels } from "./schedule.ts";

const providers = ProviderKind.options.map((value) => ({ value, label: providerLabels[value] }));
const triggers = [
  { value: "schedule", label: "On a schedule" },
  { value: "github", label: "On a GitHub event" },
  { value: "manual", label: "By hand" },
] as const;
const events = AutomationForm.shape.event.options.map((value) => ({
  value,
  label: `When ${githubEventLabels[value]}`,
}));
const missed = (["run_once", "skip"] as const).map((value) => ({
  value,
  label: missedRunLabels[value],
}));

/**
 * Create or edit an automation. Validated with the same Zod schema on every change; errors
 * show once a field has been touched or a save was attempted.
 */
export function AutomationEditor(props: {
  initial: AutomationForm;
  workspaces: readonly string[];
  submitLabel: string;
  cancel: ReactNode;
  onSave(form: AutomationForm): Promise<void>;
}) {
  const [saveError, setSaveError] = useState<string>();
  const form = useAutomationForm(props.initial, async (value) => {
    setSaveError(undefined);
    try {
      await props.onSave(value);
    } catch (error) {
      setSaveError(
        `The automations service refused it: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    }
  });
  const workspaceOptions = [...new Set([props.initial.workspace, ...props.workspaces])]
    .filter(Boolean)
    .map((value) => ({ value, label: value }));
  return (
    <form
      noValidate
      aria-label="Automation"
      className="mt-6 flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.Field name="title">
        {(field) => (
          <Row label="Name" htmlFor="automation-title" errors={visible(field.state.meta)}>
            <Input
              id="automation-title"
              value={field.state.value}
              onBlur={field.handleBlur}
              onValueChange={(value) => field.handleChange(value)}
              placeholder="Nightly dependency audit"
            />
          </Row>
        )}
      </form.Field>
      <form.Field name="prompt">
        {(field) => (
          <Row
            label="What should the agent do?"
            htmlFor="automation-prompt"
            errors={visible(field.state.meta)}
          >
            <Textarea
              id="automation-prompt"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder="Audit dependencies for advisories and open a thread with a fix for each."
              className="min-h-28"
            />
          </Row>
        )}
      </form.Field>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <form.Field name="workspace">
          {(field) => (
            <Row label="Project" errors={visible(field.state.meta)}>
              <Select
                label="Project"
                value={field.state.value}
                options={workspaceOptions}
                onValueChange={(value) => field.handleChange(value)}
                className="w-full"
              />
            </Row>
          )}
        </form.Field>
        <form.Field name="provider">
          {(field) => (
            <Row label="Agent">
              <Select
                label="Agent"
                value={field.state.value}
                options={providers}
                onValueChange={(value) => field.handleChange(value)}
                className="w-full"
              />
            </Row>
          )}
        </form.Field>
        <form.Field name="model">
          {(field) => (
            <Row label="Model" htmlFor="automation-model">
              <Input
                id="automation-model"
                value={field.state.value}
                onValueChange={(value) => field.handleChange(value)}
                placeholder="Agent's default"
              />
            </Row>
          )}
        </form.Field>
      </div>
      <form.Field name="trigger">
        {(field) => (
          <Row label="When it runs">
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
        {(trigger) =>
          trigger === "schedule" ? (
            <ScheduleFields form={form} />
          ) : trigger === "github" ? (
            <div className="grid gap-x-4 sm:grid-cols-2">
              <form.Field name="repository">
                {(field) => (
                  <Row
                    label="Repository"
                    htmlFor="automation-repo"
                    errors={visible(field.state.meta)}
                  >
                    <Input
                      id="automation-repo"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onValueChange={(value) => field.handleChange(value)}
                      placeholder="owner/name"
                      className="font-mono"
                    />
                  </Row>
                )}
              </form.Field>
              <form.Field name="event">
                {(field) => (
                  <Row label="Event">
                    <Select
                      label="Event"
                      value={field.state.value}
                      options={events}
                      onValueChange={(value) => field.handleChange(value)}
                      className="w-full"
                    />
                  </Row>
                )}
              </form.Field>
            </div>
          ) : (
            <p className="mb-4 text-sm text-muted-foreground">
              Runs only when you press Run now. Useful for a prompt you repeat.
            </p>
          )
        }
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
      </div>
      {saveError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {saveError}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        {props.cancel}
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" variant="primary" disabled={submitting}>
              {props.submitLabel}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
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
          className="block text-[13.5px] font-medium"
        >
          {props.title}
        </Title>
        <p className="mt-0.5 text-sm text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </div>
  );
}
