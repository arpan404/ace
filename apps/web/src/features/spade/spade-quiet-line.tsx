import type {
  SpadeAvatar,
  SpadeQuietLine,
  SpadeQuietMark,
  SpadeRestAction,
  SpadeRestLine,
} from "@ace/ui-core/spade-chat";
import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CircleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "./spade-face.tsx";

/** The fold-style line's shape: one quiet line, a pill on hover when it opens something. */
const quietClass =
  "ml-1.5 flex h-7 max-w-full min-w-0 items-center gap-2 rounded-full px-2 text-ui text-muted-foreground";

const marks: Record<SpadeQuietMark, { icon: typeof CircleIcon; tone: string }> = {
  done: { icon: CheckCircleIcon, tone: "text-status-done" },
  working: { icon: CircleDashedIcon, tone: "text-status-working" },
  open: { icon: CircleIcon, tone: "text-subtle-foreground" },
};

/** A plan mark (met, being worked on, open), named for assistive tech by its label. */
export function QuietMark(props: { mark: SpadeQuietMark; label: string }) {
  const { icon: Icon, tone } = marks[props.mark];
  return <Icon role="img" aria-label={props.label} size={16} className={cn("shrink-0", tone)} />;
}

/**
 * The quiet line (docs/design/spade.md §3): an event as one line where it happened, led by its
 * mark or a worker's 20px face, its subject in full ink. With `onOpen` it is a button that opens
 * what it is about, with a caret; otherwise a note.
 */
export function QuietLine(props: {
  line: SpadeQuietLine;
  /** A worker's face by its id; the Spade mark stands in for one this chat doesn't know. */
  face?: ((bot: string) => SpadeAvatar) | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const { line } = props;
  const lead = line.lead;
  const inner = (
    <>
      {lead.kind === "mark" && <QuietMark mark={lead.mark} label={lead.label} />}
      {lead.kind === "face" && props.face && (
        <SpadeFace avatar={props.face(lead.bot)} size={20} state={lead.pose} />
      )}
      <span className="min-w-0 truncate">
        {line.words.map((part, index) =>
          part.strong ? (
            <strong key={index} className="font-medium text-foreground">
              {part.text}
            </strong>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </span>
    </>
  );
  if (!props.onOpen)
    return (
      <p role="note" aria-label={line.label} className={cn(quietClass, "self-start")}>
        {inner}
      </p>
    );
  return (
    <button
      type="button"
      aria-label={line.label}
      onClick={props.onOpen}
      className={cn(quietClass, "self-start focus-ring hover:bg-hover hover:text-foreground")}
    >
      {inner}
      <CaretRightIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
    </button>
  );
}

/**
 * A reply's steps folded into one line under its words ("2 steps, 1 not run"), opening to each
 * step in a line of its own; a refused step reads "Not run: …" with the review's reason.
 */
export function StepsFold(props: {
  label: string;
  steps: readonly { key: string; text: string; refused: boolean }[];
}) {
  return (
    <div role="note" className="ml-1.5 min-w-0">
      <Disclosure
        summary={<span className="min-w-0 truncate">{props.label}</span>}
        summaryClassName="h-7 rounded-full px-2 text-ui text-muted-foreground hover:bg-hover"
        className="max-w-full"
      >
        <ol
          aria-label="Its steps"
          className="mt-1 mb-1 ml-3.5 flex flex-col gap-0.5 border-l border-border pl-3.5 text-ui text-muted-foreground"
        >
          {props.steps.map((step) => (
            <li key={step.key} className={cn("wrap-anywhere", step.refused && "text-foreground")}>
              {step.text}
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  );
}

const actionWords: Record<SpadeRestAction, { idle: string; busy: string }> = {
  wake: { idle: "Wake now", busy: "Waking…" },
  try: { idle: "Try now", busy: "Trying…" },
  cancel: { idle: "Cancel", busy: "Cancelling…" },
};

/**
 * The resting line: the working line's twin while the bot sleeps or waits (ADR 0160). Its face
 * asleep and still, until when and why, and what the person can do about it: Wake now and Cancel,
 * or Try now for an outage. A sleeping bot never reads as done.
 */
export function RestingLine(props: {
  avatar: SpadeAvatar;
  line: SpadeRestLine;
  /** Resolves false when it didn't go through (the caller said why). */
  onAction(action: SpadeRestAction): Promise<boolean>;
}) {
  const { line } = props;
  const [doing, setDoing] = useState<SpadeRestAction>();
  const act = (action: SpadeRestAction) => {
    if (doing) return;
    setDoing(action);
    void props.onAction(action).then((done) => {
      if (!done) setDoing(undefined);
    });
  };
  return (
    <div
      role="status"
      className="mt-(--chat-turn-gap) flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 first:mt-0"
    >
      <SpadeFace avatar={props.avatar} size={32} state="sleeping" />
      <span className="min-w-0 text-ui text-muted-foreground">
        {line.words}
        {line.why && <span className="text-subtle-foreground"> · {line.why}</span>}
      </span>
      <span className="flex gap-0.5">
        {line.actions.map((action) => (
          <Button
            key={action}
            size="xs"
            variant="ghost"
            disabled={doing !== undefined}
            className={cn("rounded-full", action === "cancel" && "text-muted-foreground")}
            onClick={() => act(action)}
          >
            {doing === action ? actionWords[action].busy : actionWords[action].idle}
          </Button>
        ))}
      </span>
    </div>
  );
}
