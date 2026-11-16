import {
  parseSpadeAvatar,
  spadeGroupWaiting,
  type SpadeAvatar,
  type SpadeGroupBot,
  type SpadeGroupView,
} from "@ace/ui-core/spade-chat";
import { memo } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { chatBubble, mineBubble } from "./spade-bubble-style.ts";
import { SpeakerLine } from "./spade-chat-parts.tsx";
import { SpadeFace } from "./spade-face.tsx";

/** A member as the chat shows it: its face and name, and its own chat when this window has it. */
export interface GroupFace {
  name: string;
  avatar: SpadeAvatar;
  /** Opens the member's own chat; undefined when this window can't. */
  open: (() => void) | undefined;
}

/** A member the group names that this window doesn't know: the face its id seeds. */
export const unknownFace = (bot: SpadeGroupBot): GroupFace => ({
  name: bot.name,
  avatar: parseSpadeAvatar(undefined, bot.id),
  open: undefined,
});

/**
 * A group's conversation as a chat (ADR 0132): the person's bubbles on the right in the accent,
 * each member's turn on the left starting with its face and name, a handoff
 * (`Spade asked Research`) and a queued, failed or stopped ask as one short muted line. Never a
 * tool call. While the group works, one line under the last bubble: the answering member's face
 * with moving eyes, the group's few words, `Open <bot>` when that bot waits for the person in
 * its own chat (the member the status names, `spadeGroupWaiting`). Stop is the composer's.
 */
export function SpadeGroupChat(props: {
  name: string;
  view: SpadeGroupView;
  /** The group's members, to find the one that waits for the person. */
  members: readonly SpadeGroupBot[];
  faceOf(bot: SpadeGroupBot): GroupFace;
}) {
  const { view } = props;
  const waiting = view.state === "waiting";
  const waiter = spadeGroupWaiting(view, props.members);
  const shown = waiter ?? view.working;
  const working = shown ? props.faceOf(shown) : undefined;
  return (
    <div
      role="feed"
      aria-label={`Conversation in ${props.name}`}
      aria-busy={view.busy}
      className="flex flex-col"
    >
      {view.rows.map((row, index) => (
        <Row key={row.key} row={row} previous={view.rows[index - 1]} faceOf={props.faceOf} />
      ))}
      {view.busy && (
        <div role="status" className="mt-(--chat-turn-gap) flex items-center gap-2.5 first:mt-0">
          {working ? (
            <SpadeFace
              avatar={working.avatar}
              size={32}
              state={waiting ? "needs-you" : view.status === "Thinking" ? "thinking" : "working"}
            />
          ) : (
            <span aria-hidden className="size-(--spade-working-face) shrink-0" />
          )}
          <span className="min-w-0 truncate text-ui text-muted-foreground">
            {view.status ??
              (working
                ? waiting
                  ? `${working.name} is waiting for you`
                  : `${working.name} is answering`
                : "Working")}
          </span>
          {waiter && working?.open && (
            <Button size="xs" variant="ghost" onClick={working.open}>
              {`Open ${working.name}`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type GroupRow = SpadeGroupView["rows"][number];

/** 4px within a run (a member's or the person's), 16px between turns, 20px above a speaker. */
function spaceAbove(row: GroupRow, previous: GroupRow | undefined): string {
  if (!previous) return "";
  if (row.kind === "member" && row.first) return "mt-5";
  const sameRun =
    (row.kind === "member" && !row.first) || (row.kind === "person" && previous.kind === "person");
  return sameRun ? "mt-(--chat-run-gap)" : "mt-(--chat-turn-gap)";
}

const Row = memo(function Row(props: {
  row: GroupRow;
  previous: GroupRow | undefined;
  faceOf(bot: SpadeGroupBot): GroupFace;
}) {
  const { row } = props;
  const space = spaceAbove(row, props.previous);
  switch (row.kind) {
    case "person":
      return (
        <div
          role="article"
          aria-label="You"
          aria-busy={row.sending || undefined}
          className={cn("flex flex-col items-end", row.sending && "opacity-70", space)}
        >
          <div {...part("spade-message", undefined, "user")} className={mineBubble}>
            <SpadeBubbleText text={row.text} side="mine" />
          </div>
        </div>
      );
    case "line":
      return (
        <p
          role="note"
          className={cn("text-center text-xs leading-4 text-subtle-foreground", space)}
        >
          {row.text}
        </p>
      );
    case "member": {
      const face = props.faceOf(row.bot);
      return (
        <div
          role="article"
          aria-label={face.name}
          className={cn("flex min-w-0 flex-col items-start", space)}
        >
          {row.first && <SpeakerLine avatar={face.avatar} name={face.name} />}
          <div
            {...part("spade-message", undefined, face.avatar.kind === "spade" ? "spade" : "bot")}
            className={chatBubble}
          >
            <SpadeBubbleText text={row.text} />
          </div>
        </div>
      );
    }
  }
});
