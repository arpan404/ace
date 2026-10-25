import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { Toggle } from "@base-ui/react/toggle";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { sectionRule } from "@/components/ui/rules.ts";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { cn } from "@/lib/cn.ts";
import { orderedProviders, skillNameProblem } from "./library-model.ts";

/** What a new skill is made from. */
export interface NewSkill {
  name: string;
  description: string;
  instructions: string;
  scope: "personal" | "project";
  providers: readonly ProviderKind[];
  /** Only when picked: agents never load it by themselves. */
  manual: boolean;
}

/**
 * Write a skill: its name, what it does, its instructions, where it is saved, which agents see
 * it and whether they load it by themselves. `pathFor` previews the file it will be.
 */
export function NewSkillForm(props: {
  project: string | undefined;
  agents: readonly ProviderKind[];
  initialAgents: readonly ProviderKind[];
  taken(name: string): boolean;
  pathFor(scope: NewSkill["scope"], name: string): string;
  creating: boolean;
  error: string | undefined;
  onCreate(skill: NewSkill): void;
  onCancel(): void;
}) {
  const [form, setForm] = useState<NewSkill>({
    name: "",
    description: "",
    instructions: "",
    scope: "personal",
    providers: props.initialAgents,
    manual: false,
  });
  const change = (patch: Partial<NewSkill>) => setForm((current) => ({ ...current, ...patch }));
  const name = form.name.trim();
  const problem = skillNameProblem(name, props.taken);
  const ready =
    !!name && !problem && !!form.description.trim() && form.providers.length > 0 && !props.creating;
  const ids = { name: useId(), description: useId(), instructions: useId(), error: useId() };
  return (
    <form
      className="mt-6 flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onCreate({ ...form, name, description: form.description.trim() });
      }}
    >
      <Field label="Name" htmlFor={ids.name}>
        <Input
          id={ids.name}
          value={form.name}
          placeholder="release-notes"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!problem || undefined}
          aria-describedby={problem ? ids.error : undefined}
          onValueChange={(value: string) => change({ name: value })}
        />
        {problem && (
          <p id={ids.error} className="mt-1.5 text-xs text-destructive">
            {problem}
          </p>
        )}
      </Field>
      <Field label="Description" htmlFor={ids.description}>
        <Input
          id={ids.description}
          value={form.description}
          placeholder="What it does and when an agent should use it"
          onValueChange={(value: string) => change({ description: value })}
        />
      </Field>
      <Field label="Instructions" htmlFor={ids.instructions}>
        <Textarea
          id={ids.instructions}
          value={form.instructions}
          placeholder="Steps, rules and examples the agent follows"
          spellCheck={false}
          onChange={(event) => change({ instructions: event.target.value })}
          className="min-h-50 font-mono text-sm"
        />
      </Field>
      {props.project !== undefined && (
        <Field label="Save in">
          <SegmentedControl
            label="Save in"
            value={form.scope}
            options={[
              { value: "personal", label: "Personal" },
              { value: "project", label: `${props.project} project` },
            ]}
            onValueChange={(scope) => change({ scope })}
            className="w-fit"
          />
        </Field>
      )}
      <Field label="Agents">
        <AgentToggles
          agents={props.agents}
          chosen={form.providers}
          onChange={(providers) => change({ providers })}
        />
      </Field>
      <Field label="Runs">
        <SegmentedControl
          label="Runs"
          value={form.manual ? "manual" : "auto"}
          options={[
            { value: "auto", label: "When it fits" },
            { value: "manual", label: "Only when picked" },
          ]}
          onValueChange={(value) => change({ manual: value === "manual" })}
          className="w-fit"
        />
      </Field>
      {props.error && (
        <p role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      )}
      <div className={cn(sectionRule, "flex flex-wrap items-center justify-between gap-3 pt-4")}>
        <span className="min-w-0 font-mono text-xs break-all text-subtle-foreground">
          {props.pathFor(form.scope, name || "name")}
        </span>
        <span className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!ready}>
            {props.creating ? "Creating…" : "Create skill"}
          </Button>
        </span>
      </div>
    </form>
  );
}

function Field(props: { label: string; htmlFor?: string; children: ReactNode }) {
  const Label = props.htmlFor ? "label" : "span";
  return (
    <div className="flex flex-col">
      <Label htmlFor={props.htmlFor} className="mb-1.5 text-ui font-medium">
        {props.label}
      </Label>
      {props.children}
    </div>
  );
}

/** One toggle per agent, its mark beside its name; a picked agent takes the active fill. */
export function AgentToggles(props: {
  agents: readonly ProviderKind[];
  chosen: readonly ProviderKind[];
  onChange(providers: readonly ProviderKind[]): void;
}) {
  return (
    <div role="group" aria-label="Agents" className="flex flex-wrap gap-1.5">
      {props.agents.map((agent) => {
        const on = props.chosen.includes(agent);
        return (
          <Toggle
            key={agent}
            pressed={on}
            onPressedChange={(pressed) =>
              props.onChange(
                pressed
                  ? orderedProviders([...props.chosen, agent])
                  : props.chosen.filter((each) => each !== agent),
              )
            }
            className={cn(
              "inline-flex h-(--control-height) items-center gap-1.5 rounded-md px-2.5 text-ui text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] transition-colors duration-(--motion-fast) focus-ring touch-hit hover:text-foreground",
              "data-pressed:bg-active data-pressed:text-foreground data-pressed:shadow-none",
            )}
          >
            <ProviderIcon
              provider={agent}
              size={14}
              decorative
              className={cn(!on && "opacity-50")}
            />
            {providerNames[agent]}
          </Toggle>
        );
      })}
    </div>
  );
}
