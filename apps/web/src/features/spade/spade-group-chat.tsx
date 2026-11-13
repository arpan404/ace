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
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { SpadeFace } from "./spade-face.tsx";

/** A member as the chat shows it: its face and name, and its own chat when this window has it. */
export interface GroupFace {
  name: string;
  avatar: SpadeAvatar;
  /** Opens the member's own chat; undefined when this window can't. */
  open: (() => void) | undefined;
}

const bubble =
  "min-w-0 max-w-[80%] rounded-lg px-3 py-2 font-prose text-prose leading-[1.5] wrap-anywhere";

/** A member the group names that this window doesn't know: the face its id seeds. */
export const unknownFace = (bot: SpadeGroupBot): GroupFace => ({
  name: bot.name,
  avatar: parseSpadeAvatar(undefined, bot.id),
  open: undefined,
});

/**
 * A group's conversation as a chat (ADR 0132): the person's bubbles on the right, each member's
 * on the left with its name above the first of a run and its face beside the last, a handoff
 * (`Spade asked Research`) and a queued, failed or stopped ask as one short muted line. Never a
 * tool call. While the group works, one line under the last bubble: the answering member's face
 * with moving eyes, the group's few words, `Open <bot>` when that bot waits for the person in
 * its own chat (the member the status names, `spadeGroupWaiting`), and Stop.
 */
export function SpadeGroupChat(props: {
  name: string;
  view: SpadeGroupView;
  /** The group's members, to find the one that waits for the person. */
  members: readonly SpadeGroupBot[];
  faceOf(bot: SpadeGroupBot): GroupFace;
  stopping: boolean;
  onStop(): void;
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
      className="flex flex-col gap-3"
    >
      {view.rows.map((row) => (
        <Row key={row.key} row={row} faceOf={props.faceOf} />
      ))}
      {view.busy && (
        <div role="status" className="flex items-center gap-2.5">
          {working ? (
            <SpadeFace
              avatar={working.avatar}
              size={28}
              state={waiting ? "needs-you" : view.status === "Thinking" ? "thinking" : "working"}
            />
          ) : (
            <span aria-hidden className="w-7 shrink-0" />
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
          <Button
            size="xs"
            variant="ghost"
            disabled={props.stopping}
            aria-label={`Stop ${props.name}`}
            onClick={props.onStop}
          >
            {props.stopping ? "Stopping…" : "Stop"}
          </Button>
        </div>
      )}
    </div>
  );
}

const Row = memo(function Row(props: {
  row: SpadeGroupView["rows"][number];
  faceOf(bot: SpadeGroupBot): GroupFace;
}) {
  const { row } = props;
  switch (row.kind) {
    case "person":
      return (
        <div
          role="article"
          aria-label="You"
          aria-busy={row.sending || undefined}
          className={cn("flex flex-col items-end", row.sending && "opacity-70")}
        >
          <div className={cn(bubble, "bg-active")}>
            <SpadeBubbleText text={row.text} />
          </div>
        </div>
      );
    case "line":
      return (
        <p role="note" className="text-center text-xs text-muted-foreground">
          {row.text}
        </p>
      );
    case "member": {
      const face = props.faceOf(row.bot);
      return (
        <div role="article" aria-label={face.name} className="flex flex-col gap-1">
          {row.first && <span className="pl-9.5 text-xs text-subtle-foreground">{face.name}</span>}
          <div className="flex items-end gap-2.5">
            {row.last ? (
              <SpadeFace avatar={face.avatar} size={28} />
            ) : (
              <span aria-hidden className="w-7 shrink-0" />
            )}
            <div className={cn(bubble, "bg-bubble shadow-[inset_0_0_0_1px_var(--border)]")}>
              <SpadeBubbleText text={row.text} />
            </div>
          </div>
        </div>
      );
    }
  }
});
