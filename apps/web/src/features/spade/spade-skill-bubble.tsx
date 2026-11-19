import { spadeLineChanges, type SpadeProposal } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

const code =
  "no-scrollbar -mx-2.5 mt-2.5 max-h-72 overflow-auto rounded-(--chat-code-radius) bg-chat-code px-3 py-2.5 font-mono text-[13px] leading-5 whitespace-pre-wrap";

/** The proposal's answers: words, as pills, at the bubble's size. */
const word = "rounded-full px-3 text-ui hover:bg-hover";

/**
 * A skill the bot offers (ADR 0130), as its bubble: one sentence, what it learned, the skill
 * folded away (a new one's text, an edit's changed lines), and Save and Discard as words. It is
 * never raised: only questions and requests are. Answered, the words give way to what happened.
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
    setAnswering(save);
    void props.onAnswer(save).then(() => setAnswering(undefined));
  };
  return (
    <div className={props.className} role="group" aria-label={`Skill ${proposal.name}`}>
      <p>
        {editing
          ? `${props.botName} suggests a change to the skill `
          : `${props.botName} suggests a new skill, `}
        <span className="font-mono">{proposal.name}</span>.
      </p>
      {proposal.why && <p className="mt-1 text-muted-foreground">{proposal.why}</p>}
      {open && <SkillText proposal={proposal} />}
      <div className="-mx-3 mt-1.5 -mb-1 flex flex-wrap items-center gap-1">
        {proposal.state === "open" ? (
          <>
            <Button
              variant="ghost"
              className={cn(word, "text-foreground")}
              disabled={answering !== undefined}
              onClick={() => answer(true)}
            >
              {answering === true ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              className={word}
              disabled={answering !== undefined}
              onClick={() => answer(false)}
            >
              {answering === false ? "Discarding…" : "Discard"}
            </Button>
          </>
        ) : (
          <span className="px-3 text-ui text-muted-foreground">
            {proposal.state === "saved" ? "Saved to your skills" : "Discarded"}
          </span>
        )}
        <Button
          variant="ghost"
          className={word}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {editing ? (open ? "Hide changes" : "Show changes") : open ? "Hide skill" : "Show skill"}
        </Button>
        {proposal.source && (
          <span className="min-w-0 px-3 text-ui wrap-anywhere text-subtle-foreground">
            Written after reading {proposal.source}
          </span>
        )}
      </div>
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
