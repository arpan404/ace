import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { ForgeIssueDetail, ForgeIssueWrite } from "@ace/protocol";
import { useRepoPrOptions } from "@/features/forge/index.ts";
import { ChoicePicker, type Choice } from "./new-pr-pickers.tsx";
import type { IssueWrites } from "./issue-writes.ts";

function Row(props: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="py-1 text-muted-foreground">{props.term}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 py-0.5">{props.children}</dd>
    </>
  );
}

const Quiet = (props: { children: ReactNode }) => (
  <span className="text-muted-foreground">{props.children}</span>
);

/** What a set pick changed, as the write that adds and removes it. */
function delta(before: readonly string[], after: readonly string[]) {
  return {
    add: after.filter((value) => !before.includes(value)),
    remove: before.filter((value) => !after.includes(value)),
  };
}

/**
 * Labels or assignees: the picks stay local while the list is open, then go as one write of
 * what was added and removed, so someone else's change made meanwhile is kept.
 */
function SetPicker(props: {
  label: string;
  field: "labels" | "assignees";
  issue: ForgeIssueDetail;
  writes: IssueWrites;
  choices: readonly Choice[];
  editable: boolean;
  empty: string;
}) {
  const now = props.issue[props.field];
  // The picks while open, and after until the issue reads again with them.
  const [picked, setPicked] = useState<string[] | undefined>(undefined);
  const shown = picked ?? now;
  const words = shown.length ? shown.join(", ") : <Quiet>{props.empty}</Quiet>;
  if (!props.editable) return <span className="min-w-0 truncate">{words}</span>;
  // Choices the repository list may not include (a label since deleted) still show as picked.
  const known = new Set(props.choices.map((choice) => choice.value));
  const choices = [
    ...now.filter((value) => !known.has(value)).map((value) => ({ value, label: value })),
    ...props.choices,
  ];
  return (
    <ChoicePicker
      label={props.label}
      multiple
      choices={choices}
      picked={shown}
      trigger={words}
      disabled={!props.writes.ready}
      onChange={setPicked}
      onClose={() => {
        if (!picked) return;
        const change = delta(now, picked);
        if (!change.add.length && !change.remove.length) return setPicked(undefined);
        const input: ForgeIssueWrite = {
          action: props.field,
          number: props.issue.ref.number,
          ...change,
        };
        void props.writes.write(input).finally(() => setPicked(undefined));
      }}
    />
  );
}

/**
 * The issue's people and filing, as words in a two-column list: assignees, labels, milestone
 * and the agent threads working from it. Each is changed in place where GitHub allows.
 */
export function IssueAbout(props: {
  project: string;
  issue: ForgeIssueDetail;
  writes: IssueWrites;
}) {
  const { issue, writes } = props;
  const editable = (issue.permissions.triage ?? issue.permissions.edit) && writes.ready;
  const options = useRepoPrOptions(props.project, issue.ref.repository, editable);
  const people: Choice[] = (options.data?.assignable ?? []).map((person) => ({
    value: person.login,
    label: person.login,
  }));
  const labels: Choice[] = (options.data?.labels ?? []).map((label) => ({
    value: label.name,
    label: label.name,
    hint: label.description || undefined,
    mark: label.color ? (
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: `#${label.color}` }}
      />
    ) : undefined,
  }));
  const milestones: Choice[] = [
    { value: "", label: "No milestone" },
    ...(options.data?.milestones ?? []).map((milestone) => ({
      value: String(milestone.number),
      label: milestone.title,
    })),
  ];
  const [milestone, setMilestone] = useState<string | undefined>(undefined);
  const milestoneWords =
    milestone === undefined
      ? issue.milestone
      : (milestones.find((choice) => choice.value === milestone)?.label ?? null);
  const threads = issue.relatedThreads.filter((thread) => !thread.archived);
  return (
    <section aria-labelledby="issue-about" className="mt-6">
      <h3 id="issue-about" className="mb-1 text-ui font-medium text-muted-foreground">
        About
      </h3>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 text-ui">
        <Row term="Assignees">
          <SetPicker
            label="Assignees"
            field="assignees"
            issue={issue}
            writes={writes}
            choices={people}
            editable={editable}
            empty="No one"
          />
        </Row>
        <Row term="Labels">
          <SetPicker
            label="Labels"
            field="labels"
            issue={issue}
            writes={writes}
            choices={labels}
            editable={editable}
            empty="None"
          />
        </Row>
        <Row term="Milestone">
          {editable ? (
            <ChoicePicker
              label="Milestone"
              choices={milestones}
              picked={[milestone ?? String(issue.milestoneNumber ?? "")]}
              trigger={milestoneWords ?? <Quiet>None</Quiet>}
              disabled={!writes.ready}
              onChange={([next = ""]) => {
                if (next === String(issue.milestoneNumber ?? "")) return;
                setMilestone(next);
                void writes
                  .write({
                    action: "milestone",
                    number: issue.ref.number,
                    milestone: next ? Number(next) : null,
                  })
                  .finally(() => setMilestone(undefined));
              }}
            />
          ) : (
            (issue.milestone ?? <Quiet>None</Quiet>)
          )}
        </Row>
        {threads.length > 0 && (
          <Row term="Threads">
            {threads.map((thread, index) => (
              <span key={thread.id} className="inline-flex min-w-0 items-center gap-1.5">
                {index > 0 && <Quiet>·</Quiet>}
                <Link
                  to="/t/$threadId"
                  params={{ threadId: thread.id }}
                  className="max-w-64 truncate text-foreground focus-ring hover:underline"
                >
                  {thread.title}
                </Link>
              </span>
            ))}
          </Row>
        )}
      </dl>
    </section>
  );
}
