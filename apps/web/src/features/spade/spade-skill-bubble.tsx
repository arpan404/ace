import { spadeLineChanges, type SpadeProposal } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { cardSize, CardActions } from "./spade-card.tsx";

const code =
  "no-scrollbar -mx-2.5 mt-2.5 max-h-72 overflow-auto rounded-(--chat-code-radius) bg-chat-code px-3 py-2.5 font-mono text-[13px] leading-5 whitespace-pre";

/**
 * A skill the bot offers (ADR 0130), as its bubble: one sentence, what it learned, the skill
 * folded away (a new one's text, an edit's changed lines), and shared `CardActions` with Save as
 * the primary filled pill and Discard / Show changes to its left. Answered, the actions give way
 * to what happened.
 */
export function SkillProposal(props: {
  proposal: SpadeProposal;
  botName: string;
  className: string;
  onAnswer(save: boolean): Promise<boolean>;
}) {
  const { proposal } = props;
  const [open, setOpen] = useState(false);
  const [answering, setAnswering] = useState<boolean>();
  const editing = proposal.base !== undefined;
  const answer = (save: boolean) => {
    if (answering !== undefined) return;
    setAnswering(save);
    void props.onAnswer(save).then(() => setAnswering(undefined));
  };
  const toggleLabel = editing
    ? open
      ? "Hide changes"
      : "Show changes"
    : open
      ? "Hide skill"
      : "Show skill";
  return (
    <div
      className={cn(props.className, "@container/card flex flex-col gap-3 outline-none", cardSize)}
      role="group"
      aria-label={`Skill ${proposal.name}`}
      // Focusable while open so Enter saves from the keyboard, matching approval cards.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={proposal.state === "open" ? 0 : undefined}
      onKeyDown={(event) => {
        if (
          proposal.state === "open" &&
          event.key === "Enter" &&
          event.target === event.currentTarget
        ) {
          event.preventDefault();
          answer(true);
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <p>
          {editing
            ? `${props.botName} suggests a change to the skill `
            : `${props.botName} suggests a new skill, `}
          <span className="font-mono">{proposal.name}</span>.
        </p>
        {proposal.why && <p className="text-muted-foreground">{proposal.why}</p>}
        {proposal.source && (
          <p className="text-xs leading-4 wrap-anywhere text-subtle-foreground">
            Written after reading {proposal.source}
          </p>
        )}
        {open && <SkillText proposal={proposal} />}
      </div>
      <CardActions
        aside={
          proposal.state !== "open" ? (
            <span className="text-ui text-muted-foreground">
              {proposal.state === "saved" ? "Saved to your skills" : "Discarded"}
            </span>
          ) : undefined
        }
        secondary={[
          {
            key: "toggle",
            label: toggleLabel,
            expanded: open,
            onClick: () => setOpen((o) => !o),
          },
          proposal.state === "open" && {
            key: "discard",
            label: answering === false ? "Discarding…" : "Discard",
            tone: "danger",
            disabled: answering !== undefined,
            onClick: () => answer(false),
          },
        ]}
        primary={
          proposal.state === "open"
            ? {
                label: answering === true ? "Saving…" : "Save",
                disabled: answering !== undefined,
                hint: "enter",
                onClick: () => answer(true),
              }
            : undefined
        }
      />
    </div>
  );
}

function SkillText(props: { proposal: SpadeProposal }) {
  const { proposal } = props;
  const base = proposal.base;
  const describedAgain = base && base.description !== proposal.description;
  return (
    <div>
      {(!base || describedAgain) && (
        <p className="mt-2.5 text-ui text-muted-foreground">
          {describedAgain ? `Use it: ${proposal.description}` : proposal.description}
        </p>
      )}
      {base ? (
        <Changes before={base.body} after={proposal.body} />
      ) : (
        <pre aria-label="Skill text" className={code}>
          {proposal.body}
        </pre>
      )}
    </div>
  );
}

/** An edit's lines: removed ones struck on the deletion fill, added ones on the addition fill. */
function Changes(props: { before: string; after: string }) {
  const changes = spadeLineChanges(props.before, props.after);
  if (!changes)
    return (
      <pre aria-label="Skill text" className={code}>
        {props.after}
      </pre>
    );
  return (
    <pre aria-label="Changes" className={cn(code, "px-0")}>
      {changes.map((line, index) => (
        <span
          // Lines repeat; their place is their identity.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className={cn(
            "block px-2.5",
            line.kind === "added" && "bg-diff-add",
            line.kind === "removed" && "bg-diff-del text-muted-foreground line-through",
          )}
        >
          <span aria-hidden className="mr-2 select-none text-subtle-foreground">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
          </span>
          <span className="sr-only">
            {line.kind === "added" ? "Added: " : line.kind === "removed" ? "Removed: " : ""}
          </span>
          {line.text || " "}
        </span>
      ))}
    </pre>
  );
}
