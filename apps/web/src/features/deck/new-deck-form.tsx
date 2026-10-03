import { useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import type { SidebarReader } from "@ace/client";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useDeckRuns, useDeckSender } from "./deck-source.ts";
import {
  NewDeckInput,
  deckId,
  deckSpec,
  type DeckProvider,
  type MergePolicy,
} from "./deck-spec.ts";

const providers: readonly { value: DeckProvider; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
];
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

const readWorkspaces = (reader: SidebarReader) =>
  reader.ids.flatMap((id) => reader.thread(id)?.workspaceId ?? []).join("\n");

/** Projects the user already works in: from the thread list and existing decks. */
function useProjects(): string[] {
  const ids = useSidebarIds() ?? [];
  const keys: SidebarKey[] = ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)];
  const fromThreads = useSidebar(keys, readWorkspaces) ?? "";
  const { runs } = useDeckRuns();
  return [...new Set([...fromThreads.split("\n"), ...runs.map((run) => run.workspaceId)])]
    .filter(Boolean)
    .toSorted();
}

function message(errors: readonly unknown[]): string | undefined {
  const first = errors[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "message" in first && typeof first.message === "string")
    return first.message;
  return undefined;
}

/** ⌘⇧N: describe the goal, choose who works and who reviews, and how the deck may merge. */
export function NewDeckForm() {
  const projects = useProjects();
  const send = useDeckSender();
  const navigate = useNavigate();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const form = useForm({
    defaultValues: {
      goal: "",
      workspaceId: "",
      worker: "claude" as DeckProvider,
      reviewer: "codex" as DeckProvider,
      planApproval: true,
      merge: "ask" as MergePolicy,
      maxParallel: 3,
      fixRounds: 2,
    },
    // The project falls back to the first one listed, so only the rest is validated here.
    validators: { onSubmit: NewDeckInput.extend({ workspaceId: z.string() }) },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const parsed = NewDeckInput.safeParse({
        ...value,
        workspaceId: value.workspaceId || projects[0] || "",
      });
      if (!parsed.success) {
        setError("Pick a project. Decks run in a project you already have threads in.");
        return;
      }
      const input = parsed.data;
      const runId = deckId(input.goal, Date.now().toString(36));
      try {
        await send({
          type: "conductor.start",
          runId,
          spec: deckSpec(input, `deck-${runId}`),
        });
        toast.add({
          title: input.planApproval ? "Deck started · review the plan" : "Deck started",
        });
        await navigate({ to: "/deck/$runId", params: { runId } });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "The deck didn't start.");
      }
    },
  });
  const submit = () => void form.handleSubmit();
  return (
    <form
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
            {(id) => (
              <Textarea
                id={id}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                placeholder="Make every relay stream resumable after a daemon restart, without duplicate events."
                className="min-h-28 text-base"
              />
            )}
          </Row>
        )}
      </form.Field>
      <div className="grid grid-cols-3 gap-4">
        <form.Field name="workspaceId">
          {(field) => (
            <Row label="Project">
              {() => (
                <Select
                  label="Project"
                  value={field.state.value || projects[0] || ""}
                  options={projects.map((id) => ({ value: id, label: id }))}
                  onValueChange={field.handleChange}
                  className="w-full"
                />
              )}
            </Row>
          )}
        </form.Field>
        <form.Field name="worker">
          {(field) => (
            <Row label="Workers">
              {() => (
                <Select
                  label="Workers"
                  value={field.state.value}
                  options={providers}
                  onValueChange={(value) => field.handleChange(value)}
                  className="w-full"
                />
              )}
            </Row>
          )}
        </form.Field>
        <form.Field name="reviewer">
          {(field) => (
            <Row label="Reviewers">
              {() => (
                <Select
                  label="Reviewers"
                  value={field.state.value}
                  options={providers}
                  onValueChange={(value) => field.handleChange(value)}
                  className="w-full"
                />
              )}
            </Row>
          )}
        </form.Field>
      </div>
      <form.Field name="planApproval">
        {(field) => (
          <label className="flex items-center gap-4 border-t pt-4">
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium">Approve the plan first</span>
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
            <h2 id="merge-policy" className="text-[13.5px] font-medium">
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
      <div className="grid grid-cols-3 gap-4 border-t pt-4">
        <form.Field name="maxParallel">
          {(field) => (
            <Row label="Lanes at once">
              {() => (
                <Select
                  label="Lanes at once"
                  value={String(field.state.value)}
                  options={counts([1, 2, 3, 4, 6, 8])}
                  onValueChange={(value) => field.handleChange(Number(value))}
                  className="w-full"
                />
              )}
            </Row>
          )}
        </form.Field>
        <form.Field name="fixRounds">
          {(field) => (
            <Row label="Fix rounds before escalating">
              {() => (
                <Select
                  label="Fix rounds before escalating"
                  value={String(field.state.value)}
                  options={counts([0, 1, 2, 3, 5])}
                  onValueChange={(value) => field.handleChange(Number(value))}
                  className="w-full"
                />
              )}
            </Row>
          )}
        </form.Field>
      </div>
      {error && (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-3">
        <span className="text-sm text-subtle-foreground">
          The deck drafts a plan before any agent starts.
        </span>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" variant="primary" disabled={submitting}>
              Start deck
              <Kbd keys="mod+enter" variant="bare" className="text-primary-foreground/60" />
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

function Row(props: {
  label: string;
  error?: string | undefined;
  children(id: string): ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-muted-foreground">
        {props.label}
      </label>
      {props.children(id)}
      {props.error && (
        <p role="alert" className="text-sm text-destructive">
          {props.error}
        </p>
      )}
    </div>
  );
}
