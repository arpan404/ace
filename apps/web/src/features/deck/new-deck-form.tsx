import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { CaretDownIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { ProviderKind } from "@ace/protocol";
import { deckProviderChoices, type DeckProviderChoice } from "@ace/ui-core";
import { useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useNewThreadOptions } from "@/features/models/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useDeckRuns, useDeckSender } from "./deck-source.ts";
import { useDeckToast } from "./deck-keys.ts";
import { DeckCommandError } from "./deck-store.ts";
import { NewDeckInput, deckId, deckSpec, defaultBudget, type MergePolicy } from "./deck-spec.ts";
import { useProjectChoices } from "@/lib/projects.ts";

const merges: readonly { value: MergePolicy; title: string; description: string }[] = [
  {
    value: "ask",
    title: "Ask me before merging",
    description: "Cards merge into the deck branch; main waits for your approval.",
  },
  {
    value: "auto-after-verification",
    title: "Merge when every review passes",
    description: "No final gate. Reviewers and tests decide.",
  },
  {
    value: "PR-only",
    title: "Open a pull request only",
    description: "The deck stops at a PR you merge yourself.",
  },
];
const counts = (values: number[]) => values.map((n) => ({ value: String(n), label: String(n) }));
const stopAfter = [
  { value: "none", label: "No limit" },
  { value: "2h", label: "2 hours" },
  { value: "8h", label: "8 hours" },
  { value: "1d", label: "1 day" },
] as const;
type StopAfter = (typeof stopAfter)[number]["value"];

/** Every project on this daemon, plus any an existing deck runs in. */
function useProjects() {
  const { runs } = useDeckRuns();
  const fromRuns = useMemo(() => runs.map((run) => run.workspaceId), [runs]);
  return useProjectChoices(fromRuns);
}

function message(errors: readonly unknown[]): string | undefined {
  const first = errors[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "message" in first && typeof first.message === "string")
    return first.message;
  return undefined;
}

/** The providers this daemon can run a deck on; undefined until both catalogs have arrived. */
function useDeckProviders(): readonly DeckProviderChoice[] | undefined {
  const options = useNewThreadOptions();
  return useMemo(() => options && deckProviderChoices(options.models, options.accounts), [options]);
}

/** Claude Code works and a second provider reviews, when the daemon has both. */
function defaults(choices: readonly DeckProviderChoice[]) {
  const worker = (choices.find((c) => c.provider === "claude") ?? choices[0])?.provider;
  const reviewer = (choices.find((c) => c.provider !== worker) ?? choices[0])?.provider;
  return { worker, reviewer };
}

/** Why the deck didn't start, as a sentence: the daemon's refusal or why it couldn't be asked. */
function startFailure(failure: unknown): string {
  if (failure instanceof DeckCommandError) return failure.message;
  if (failure instanceof Error && failure.message === "provider_unavailable")
    return "That provider isn't available on this daemon any more. Pick another.";
  return describeDaemonError(daemonErrorCode(failure));
}

/** A typed budget, or the default for the lanes at once when the field is left empty. */
function budgetOf(text: string, maxParallel: number): number {
  return text.trim() === "" ? defaultBudget(maxParallel) : Number(text);
}

/** Focus the first field the submit found wrong, once its error has rendered. */
function focusInvalid(form: HTMLFormElement | null) {
  requestAnimationFrame(() =>
    form?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid-target]')?.focus(),
  );
}

/** ⌘⇧N: describe the goal, choose who works and who reviews, and how the deck may merge. */
export function NewDeckForm() {
  const { ids: projects, name: projectName } = useProjects();
  const choices = useDeckProviders();
  const fallback = defaults(choices ?? []);
  const send = useDeckSender();
  const navigate = useNavigate();
  const toast = useDeckToast();
  const dialogs = useProjectDialogs();
  const element = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string>();
  const noProjects = projects.length === 0;
  const form = useForm({
    defaultValues: {
      goal: "",
      workspaceId: "",
      worker: "" as ProviderKind | "",
      reviewer: "" as ProviderKind | "",
      planApproval: true,
      merge: "ask" as MergePolicy,
      maxParallel: 3,
      fixRounds: 2,
      budget: "",
      stopAfter: "none" as StopAfter,
    },
    // Project and providers fall back to the first offered, and an empty budget to the default
    // for the lanes at once, so only the rest is validated here.
    validators: {
      onSubmit: NewDeckInput.extend({
        workspaceId: z.string(),
        worker: ProviderKind.or(z.literal("")),
        reviewer: ProviderKind.or(z.literal("")),
        budget: z
          .string()
          .refine(
            (text) =>
              text.trim() === "" ||
              (/^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 100_000),
            "Enter a whole number of lane starts, from 1 to 100,000.",
          ),
      }),
    },
    onSubmitInvalid: () => focusInvalid(element.current),
    onSubmit: async ({ value }) => {
      setError(undefined);
      if (!choices?.length) {
        setError(noProviders);
        return;
      }
      const parsed = NewDeckInput.safeParse({
        ...value,
        workspaceId: value.workspaceId || projects[0] || "",
        worker: value.worker || fallback.worker,
        reviewer: value.reviewer || fallback.reviewer,
        budget: budgetOf(value.budget, value.maxParallel),
      });
      if (!parsed.success) {
        setError("Pick a project. Decks run in a project you already have threads in.");
        focusInvalid(element.current);
        return;
      }
      const input = parsed.data;
      const runId = deckId(input.goal, Date.now().toString(36));
      try {
        await send({
          type: "conductor.start",
          runId,
          spec: deckSpec(input, choices, crypto.randomUUID(), Date.now()),
        });
        toast.done(input.planApproval ? "Deck started · review the plan" : "Deck started");
        await navigate({ to: "/deck/$runId", params: { runId } });
      } catch (failure) {
        setError(startFailure(failure));
      }
    },
  });
  const submit = () => void form.handleSubmit();
  return (
    <form
      ref={element}
      aria-label="New deck"
      noValidate
      className="mt-7 flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <form.Field name="goal">
        {(field) => (
          <Row label="Goal" error={message(field.state.meta.errors)}>
            {(id, describedBy) => (
              <Textarea
                id={id}
                // The page is this field: typing starts as soon as it opens.
                autoFocus
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                aria-describedby={describedBy}
                placeholder="Make every relay stream resumable after a daemon restart, without duplicate events."
                className="min-h-28 text-base"
              />
            )}
          </Row>
        )}
      </form.Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <form.Field name="workspaceId">
          {(field) => (
            <Row
              label="Project"
              hint={noProjects ? "Decks run inside a project." : undefined}
              labelFor={!noProjects}
            >
              {() =>
                noProjects ? (
                  <Button
                    type="button"
                    variant="secondary"
                    data-invalid-target
                    className="w-full justify-start"
                    onClick={() => dialogs.open({ kind: "add", tab: "open" })}
                  >
                    <Icon icon={FolderPlusIcon} size={14} />
                    Add project…
                  </Button>
                ) : (
                  <Select
                    label="Project"
                    value={field.state.value || projects[0] || ""}
                    options={projects.map((id) => ({ value: id, label: projectName(id) }))}
                    onValueChange={field.handleChange}
                    className="w-full min-w-0"
                  />
                )
              }
            </Row>
          )}
        </form.Field>
        <form.Field name="worker">
          {(field) => (
            <Row label="Workers" labelFor={false}>
              {() => (
                <Select
                  label="Workers"
                  value={field.state.value || fallback.worker || ""}
                  options={providerOptions(choices)}
                  onValueChange={(value) => field.handleChange(value as ProviderKind)}
                  className="w-full min-w-0"
                />
              )}
            </Row>
          )}
        </form.Field>
        <form.Field name="reviewer">
          {(field) => (
            <Row label="Reviewers" labelFor={false}>
              {() => (
                <Select
                  label="Reviewers"
                  value={field.state.value || fallback.reviewer || ""}
                  options={providerOptions(choices)}
                  onValueChange={(value) => field.handleChange(value as ProviderKind)}
                  className="w-full min-w-0"
                />
              )}
            </Row>
          )}
        </form.Field>
      </div>
      <form.Subscribe selector={(state) => [state.values.worker, state.values.reviewer] as const}>
        {([worker, reviewer]) => (
          <Lineup
            choices={choices}
            worker={worker || fallback.worker}
            reviewer={reviewer || fallback.reviewer}
          />
        )}
      </form.Subscribe>
      <form.Field name="planApproval">
        {(field) => (
          <label className="flex items-center gap-4 border-t pt-4">
            <span className="min-w-0 flex-1">
              <span className="block text-ui font-medium">Approve the plan first</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">
                No agent starts until you approve the cards. Recommended.
              </span>
            </span>
            <Switch checked={field.state.value} onCheckedChange={field.handleChange} />
          </label>
        )}
      </form.Field>
      <form.Field name="merge">
        {(field) => (
          <div className="border-t pt-4">
            <h2 id="merge-policy" className="text-ui font-medium">
              When the cards pass review
            </h2>
            <RadioGroup
              aria-labelledby="merge-policy"
              value={field.state.value}
              onValueChange={(value) => {
                const picked = merges.find((option) => option.value === value);
                if (picked) field.handleChange(picked.value);
              }}
              className="mt-3 gap-2"
            >
              {merges.map((option) => (
                <label key={option.value} className="flex items-start gap-3 py-1">
                  <RadioGroupItem value={option.value} className="mt-0.5" />
                  <span>
                    <span className="block text-ui">{option.title}</span>
                    <span className="block text-sm text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
        )}
      </form.Field>
      <div className="grid grid-cols-1 gap-4 border-t pt-4 sm:grid-cols-3">
        <form.Field name="maxParallel">
          {(field) => (
            <Row label="Lanes at once" labelFor={false}>
              {() => (
                <Select
                  label="Lanes at once"
                  value={String(field.state.value)}
                  options={counts([1, 2, 3, 4, 6, 8])}
                  onValueChange={(value) => field.handleChange(Number(value))}
                  className="w-full min-w-0"
                />
              )}
            </Row>
          )}
        </form.Field>
        <form.Field name="fixRounds">
          {(field) => (
            <Row label="Fix rounds before escalating" labelFor={false}>
              {() => (
                <Select
                  label="Fix rounds before escalating"
                  value={String(field.state.value)}
                  options={counts([0, 1, 2, 3, 5])}
                  onValueChange={(value) => field.handleChange(Number(value))}
                  className="w-full min-w-0"
                />
              )}
            </Row>
          )}
        </form.Field>
      </div>
      {/* Budget and deadline: closed by default, since the defaults suit most decks. */}
      <Collapsible className="border-t pt-4">
        <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-xs text-ui font-medium outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]">
          {/* WP-1: focus-ring */}
          <Icon
            icon={CaretDownIcon}
            size={12}
            className="text-muted-foreground transition-transform duration-(--dur-2)"
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-3">
          <form.Subscribe selector={(state) => state.values.maxParallel}>
            {(lanes) => (
              <form.Field name="budget">
                {(field) => (
                  <Row
                    label="Lane starts budget"
                    hint="Each worker, reviewer or fix run counts as one."
                    error={message(field.state.meta.errors)}
                  >
                    {(id, describedBy) => (
                      <Input
                        id={id}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        placeholder={String(defaultBudget(lanes))}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.currentTarget.value)}
                        onBlur={field.handleBlur}
                        aria-invalid={field.state.meta.errors.length > 0 || undefined}
                        aria-describedby={describedBy}
                        className="tabular-nums"
                      />
                    )}
                  </Row>
                )}
              </form.Field>
            )}
          </form.Subscribe>
          <form.Field name="stopAfter">
            {(field) => (
              <Row label="Stop after" labelFor={false}>
                {() => (
                  <Select<StopAfter>
                    label="Stop after"
                    value={field.state.value}
                    options={stopAfter}
                    onValueChange={field.handleChange}
                    className="w-full min-w-0"
                  />
                )}
              </Row>
            )}
          </form.Field>
        </CollapsibleContent>
      </Collapsible>
      {error && (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <form.Subscribe selector={(state) => state.values.planApproval}>
          {(approval) => (
            <span className="text-sm text-muted-foreground">
              {approval
                ? "You approve the plan before any lane starts."
                : "Lanes start as soon as the plan is drafted."}
            </span>
          )}
        </form.Subscribe>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => {
            const button = (
              <Button
                type="submit"
                variant="primary"
                disabled={submitting || !choices?.length || noProjects}
              >
                {submitting ? "Starting…" : "Start deck"}
                <Kbd keys="mod+enter" variant="bare" className="text-tint-foreground/60" />
              </Button>
            );
            // A disabled button shows no tooltip of its own; its wrapper says why.
            return noProjects ? (
              <Tip label="Add a project first">
                <span
                  tabIndex={0}
                  className="rounded-md outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]"
                >
                  {button}
                </span>
              </Tip>
            ) : (
              button
            );
          }}
        </form.Subscribe>
      </div>
    </form>
  );
}

const noProviders =
  "No provider on this daemon can run a deck. Sign in to Claude Code, Codex or OpenCode on that machine.";

function providerOptions(choices: readonly DeckProviderChoice[] | undefined) {
  return (choices ?? []).map((choice) => ({ value: choice.provider, label: choice.label }));
}

/** Who will do the work, in words: each role's model and the accounts it may use. */
function Lineup(props: {
  choices: readonly DeckProviderChoice[] | undefined;
  worker: ProviderKind | undefined;
  reviewer: ProviderKind | undefined;
}) {
  if (!props.choices)
    return <p className="-mt-3 text-sm text-muted-foreground">Reading this daemon's models…</p>;
  if (!props.choices.length)
    return (
      <p role="alert" className="-mt-3 text-sm text-status-failed">
        {noProviders}
      </p>
    );
  const line = (role: string, provider: ProviderKind | undefined) => {
    const choice = props.choices?.find((entry) => entry.provider === provider);
    return choice
      ? `${role} run ${choice.modelLabel} on ${choice.label} · ${choice.accountLabel}.`
      : "";
  };
  return (
    <div className="-mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
      <p>
        {line("Workers", props.worker)} {line("Reviewers", props.reviewer)}
      </p>
      {props.worker && props.worker === props.reviewer && props.choices.length > 1 && (
        <p className="text-status-needs-you">
          The same provider reviews its own work. A different one catches more.
        </p>
      )}
    </div>
  );
}

function Row(props: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  /** The label names a field by id; selects name themselves (`aria-label`). */
  labelFor?: boolean;
  children(id: string, describedBy: string | undefined): ReactNode;
}) {
  const id = useId();
  const hint = `${id}-hint`;
  const error = `${id}-error`;
  const describedBy =
    [props.hint ? hint : undefined, props.error ? error : undefined].filter(Boolean).join(" ") ||
    undefined;
  const Label = props.labelFor === false ? "span" : "label";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label
        {...(props.labelFor === false ? {} : { htmlFor: id })}
        className="text-sm font-medium text-muted-foreground"
      >
        {props.label}
      </Label>
      {props.children(id, describedBy)}
      {props.hint && (
        <p id={hint} className="text-sm text-muted-foreground">
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={error} role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      )}
    </div>
  );
}
