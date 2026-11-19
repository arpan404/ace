import type {
  SpadeAvatar,
  SpadeQuietLine,
  SpadeQuietMark,
  SpadeRestAction,
  SpadeRestLine,
} from "@ace/ui-core/spade-chat";
import { CaretRightIcon, CheckCircleIcon, CircleDashedIcon, CircleIcon } from "@ace/icons";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
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
        {line.words.map((part) =>
          part.strong ? (
            <strong key={part.text} className="font-medium text-foreground">
              {part.text}
            </strong>
          ) : (
            <span key={part.text}>{part.text}</span>
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
      className="mt-(--chat-turn-gap) flex min-w-0 items-center gap-2.5 first:mt-0"
    >
      <SpadeFace avatar={props.avatar} size={32} state="sleeping" />
      {/* On a narrow screen the actions wrap under the words, not under the face. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
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
              className={cn(
                "rounded-full pointer-coarse:h-11 pointer-coarse:px-3.5",
                action === "cancel" && "text-muted-foreground",
              )}
              onClick={() => act(action)}
            >
              {doing === action ? actionWords[action].busy : actionWords[action].idle}
            </Button>
          ))}
        </span>
      </span>
    </div>
  );
}
