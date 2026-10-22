import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ForgeNewPrContext } from "@ace/protocol";
import { LabelPill } from "@/components/forge-marks.tsx";
import { MarkdownEditor } from "@/components/markdown-editor/markdown-editor.tsx";
import { useMarkdownDraft } from "@/components/markdown-editor/use-markdown-draft.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { WorkHeading } from "@/components/work-heading.tsx";
import { Screen } from "@/features/shell/index.ts";
import { readFailureText, useRepoPrOptions } from "@/features/forge/index.ts";
import { applePlatform } from "@/lib/keymap.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { useBackToList } from "./back-to-list.ts";
import { readable } from "./issue-page.tsx";
import { useProjectChoice } from "./project-choice.ts";
import { ChoicePicker } from "./new-pr-pickers.tsx";
import { compareBlocker, compareSummary, prefill, startingBase } from "./new-pr-model.ts";
import { useCompare, useCreatePr, useNewPrContext } from "./new-pr-data.ts";
import { NewPrChanges } from "./new-pr-changes.tsx";

/**
 * A new pull request from any branch, as a page laid out as the PR it becomes: back to the
 * list, the title in large type, which branch merges into which, the description (the
 * repository's template when it has one), who reviews it and how it is filed, then what it
 * brings: its commits and its changed files. Created, its page opens in this one's place.
 */
export function NewPullRequestPage(props: {
  project: string;
  base: string | undefined;
  head: string | undefined;
  back: string | undefined;
}) {
  const { project } = props;
  const choice = useProjectChoice(project);
  const back = useBackToList("/pulls", project, props.back);
  const context = useNewPrContext(project);
  // Who reviews it and how it is filed stay while branches are switched; each branch keeps its
  // own title and description.
  const [details, setDetails] = useState<PrDetailsDraft>(noDetails);
  return (
    <Screen title="New pull request" crumb={choice.name(project)}>
      <article aria-label="New pull request" className="h-full overflow-y-auto">
        <div className={`${readable} pt-6 pb-16`}>
          {context.data ? (
            <NewPrForm
              key={`${context.data.base.repository.name}:${props.head ?? ""}`}
              project={project}
              details={details}
              onDetails={setDetails}
              context={context.data}
              base={props.base}
              head={props.head}
              back={props.back}
              onBack={back}
            />
          ) : (
            <>
              <WorkHeading
                back={{ label: "Pull requests", onBack: back }}
                title={<h1 className="text-xl font-semibold tracking-title">New pull request</h1>}
              />
              {context.error ? (
                <EmptyState
                  variant="inline"
                  title="Couldn't read the repository's branches"
                  description={readFailureText(context.error)}
                  action={
                    <Button size="sm" onClick={() => void context.refetch()}>
                      Try again
                    </Button>
                  }
                />
              ) : (
                <div aria-busy className="mt-6 h-40" />
              )}
            </>
          )}
        </div>
      </article>
    </Screen>
  );
}

/** What a new PR is given besides its text. */
interface PrDetailsDraft {
  reviewers: string[];
  assignees: string[];
  labels: string[];
  milestone: number | undefined;
  draft: boolean;
}
const noDetails: PrDetailsDraft = {
  reviewers: [],
  assignees: [],
  labels: [],
  milestone: undefined,
  draft: false,
};

function NewPrForm(props: {
  project: string;
  details: PrDetailsDraft;
  onDetails(next: PrDetailsDraft): void;
  context: ForgeNewPrContext;
  base: string | undefined;
  head: string | undefined;
  back: string | undefined;
  onBack(): void;
}) {
  const { project, context } = props;
  const navigate = useNavigate();
  const base = startingBase(context, props.base);
  const head = context.head.branches.some((branch) => branch.name === props.head)
    ? props.head
    : undefined;
  // The branches live in the address, so a reload or a shared link keeps them.
  const pickBranches = (next: { base?: string; head?: string }) =>
    void navigate({
      to: "/pulls/$project/new",
      params: { project },
      search: { base: next.base ?? base, head: next.head ?? head, back: props.back },
      replace: true,
    });
  const headRef = head ? { owner: context.head.repository.owner, branch: head } : undefined;
  const fork = context.head.repository.owner !== context.base.repository.owner;
  const compare = useCompare(project, base, headRef, 1, !fork);
  const blocker = compareBlocker(base, head, compare.data, !fork);
  const ready = compare.data && !blocker ? compare.data : undefined;
  const draftKey = `pr:${project}:new:${head ?? ""}`;
  const title = useMarkdownDraft(head ? `${draftKey}:title` : undefined);
  const body = useMarkdownDraft(head ? draftKey : undefined);
  const [touched, setTouched] = useState({ title: false, body: false });
  // Until the person writes their own, the title and description follow the branch picked.
  const filled = ready ? prefill(head ?? "", ready, context.template) : undefined;
  useEffect(() => {
    if (!filled) return;
    if (!touched.title && !title.text) title.setText(filled.title);
    if (!touched.body && !body.text) body.setText(filled.body);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per comparison read.
  }, [filled?.title, filled?.body]);
  const options = useRepoPrOptions(project, undefined, true);
  const { reviewers, assignees, labels, milestone, draft } = props.details;
  const set = (patch: Partial<PrDetailsDraft>) => props.onDetails({ ...props.details, ...patch });
  const setReviewers = (next: string[]) => set({ reviewers: next });
  const setAssignees = (next: string[]) => set({ assignees: next });
  const setLabels = (next: string[]) => set({ labels: next });
  const setMilestone = (next: number | undefined) => set({ milestone: next });
  const setDraft = (next: boolean) => set({ draft: next });
  const create = useCreatePr(project);
  const existing = ready?.existingPr;
  const canCreate = !!ready && !existing && !!title.text.trim() && !create.pending;
  const openExisting = (number: number) =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(number) },
      search: { repo: repositoryParam(context.base.repository), back: props.back },
    });
  const submit = async () => {
    if (!canCreate || !head) return;
    const pr = await create.run({
      repository: context.base.repository,
      base,
      head: { owner: context.head.repository.owner, branch: head },
      title: title.text.trim(),
      body: body.text,
      draft,
      reviewers,
      labels,
      assignees,
      ...(milestone ? { milestone } : {}),
    });
    if (!pr) return;
    title.clear();
    body.clear();
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(pr.number) },
      search: { back: props.back },
      replace: true,
    });
  };
  const people = (options.data?.assignable ?? []).map((person) => ({
    value: person.login,
    label: person.login,
  }));
  const branchChoices = (side: "base" | "head") =>
    context[side].branches.map((branch) => ({
      value: branch.name,
      label: branch.name,
      ...(side === "base" && branch.name === context.base.defaultBranch
        ? { hint: "Default branch" }
        : {}),
    }));
  const milestones = options.data?.milestones ?? [];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <WorkHeading
        back={{ label: "Pull requests", onBack: props.onBack }}
        title={
          <input
            aria-label="Title"
            placeholder="Title"
            maxLength={256}
            value={title.text}
            onChange={(event) => {
              setTouched((current) => ({ ...current, title: true }));
              title.setText(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const mod = applePlatform ? event.metaKey : event.ctrlKey;
              if (mod) event.currentTarget.form?.requestSubmit();
              else
                event.currentTarget.form?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
            }}
            className="h-9 w-full min-w-0 bg-transparent text-xl font-semibold tracking-title text-foreground placeholder:font-normal focus:outline-none placeholder:text-subtle-foreground"
          />
        }
        byline={
          <span className="-ml-1.5 flex min-w-0 flex-wrap items-center gap-x-1">
            <ChoicePicker
              label="Branch with your changes"
              mono
              choices={branchChoices("head")}
              picked={head ? [head] : []}
              trigger={
                head ? (
                  fork ? (
                    `${context.head.repository.owner}:${head}`
                  ) : (
                    head
                  )
                ) : (
                  <span className="font-sans text-ui text-muted-foreground">Pick a branch</span>
                )
              }
              onChange={([next]) => next && pickBranches({ head: next })}
            />
            <span>into</span>
            <ChoicePicker
              label="Base branch"
              mono
              choices={branchChoices("base")}
              picked={[base]}
              trigger={fork ? `${context.base.repository.owner}:${base}` : base}
              onChange={([next]) => next && pickBranches({ base: next })}
            />
            {ready ? (
              <span className="ml-1.5 text-subtle-foreground tabular-nums">
                {compareSummary(ready)}
                {existing && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => openExisting(existing)}
                      className="rounded-xs text-link focus-ring hover:underline"
                    >
                      {`#${existing} is already open`}
                    </button>
                  </>
                )}
              </span>
            ) : compare.error ? (
              <span className="ml-1.5 text-muted-foreground">{readFailureText(compare.error)}</span>
            ) : (
              head && blocker && <span className="ml-1.5 text-muted-foreground">{blocker}</span>
            )}
          </span>
        }
      />
      <MarkdownEditor
        className="mt-4"
        size="page"
        label="Description"
        onSubmit={() => void submit()}
        placeholder="Add a description"
        maxLength={65_536}
        value={body.text}
        onChange={(text) => {
          setTouched((current) => ({ ...current, body: true }));
          body.setText(text);
        }}
      />
      <div className="mt-4" role="group" aria-label="Pull request details">
        <Field label="Reviewers">
          <ChoicePicker
            label="Reviewers"
            multiple
            disabled={!options.data}
            choices={people}
            picked={reviewers}
            trigger={reviewers.length ? reviewers.join(", ") : <Quiet>None</Quiet>}
            onChange={setReviewers}
          />
        </Field>
        <Field label="Assignees">
          <ChoicePicker
            label="Assignees"
            multiple
            disabled={!options.data}
            choices={people}
            picked={assignees}
            trigger={assignees.length ? assignees.join(", ") : <Quiet>None</Quiet>}
            onChange={(next) => setAssignees(next.slice(0, 10))}
          />
        </Field>
        <Field label="Labels">
          <ChoicePicker
            label="Labels"
            multiple
            disabled={!options.data}
            choices={(options.data?.labels ?? []).map((label) => ({
              value: label.name,
              label: label.name,
              hint: label.description || undefined,
              mark: (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: label.color ? `#${label.color}` : undefined }}
                />
              ),
            }))}
            picked={labels}
            trigger={
              labels.length ? (
                <span className="flex flex-wrap gap-1">
                  {labels.map((name) => (
                    <LabelPill
                      key={name}
                      name={name}
                      color={options.data?.labels.find((label) => label.name === name)?.color}
                    />
                  ))}
                </span>
              ) : (
                <Quiet>None</Quiet>
              )
            }
            onChange={setLabels}
          />
        </Field>
        <Field label="Milestone">
          <ChoicePicker
            label="Milestone"
            disabled={!options.data}
            choices={[
              { value: "", label: "No milestone" },
              ...milestones.map((each) => ({
                value: String(each.number),
                label: each.title,
                hint: each.dueOn
                  ? `Due ${new Date(each.dueOn).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`
                  : undefined,
              })),
            ]}
            picked={[milestone ? String(milestone) : ""]}
            trigger={
              milestones.find((each) => each.number === milestone)?.title ?? <Quiet>None</Quiet>
            }
            onChange={([next]) => setMilestone(next ? Number(next) : undefined)}
          />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <label className="mr-auto flex items-center gap-2 text-ui whitespace-nowrap text-muted-foreground">
          <Switch checked={draft} onCheckedChange={setDraft} />
          Open as a draft
        </label>
        <Button type="button" variant="ghost" onClick={props.onBack}>
          Cancel
        </Button>
        {existing ? (
          // GitHub takes one open PR per head and base: this pair already has it.
          <Button type="button" variant="primary" onClick={() => openExisting(existing)}>
            {`Open pull request #${existing}`}
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!canCreate}>
            {draft ? "Create draft pull request" : "Create pull request"}
            <Kbd aria-hidden variant="on-primary" resolve={false} keys="mod+enter" />
          </Button>
        )}
      </div>
      {headRef && ready && (
        <NewPrChanges
          project={project}
          base={base}
          head={headRef}
          first={ready}
          sameRepository={!fork}
        />
      )}
    </form>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-3 text-ui">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <div className="-ml-1.5 min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

function Quiet(props: { children: React.ReactNode }) {
  return <span className="text-subtle-foreground">{props.children}</span>;
}
