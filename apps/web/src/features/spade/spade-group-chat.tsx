import {
  parseSpadeAvatar,
  spadeGroupWaiting,
  spadePlainText,
  spadeQuoteLine,
  spadeWorkingPhrase,
  type SpadeAgentStyle,
  type SpadeAvatar,
  type SpadeQuote,
  type SpadeGroupBot,
  type SpadeGroupView,
} from "@ace/ui-core/spade-chat";
import { memo, useCallback, useMemo } from "react";
import { useHeldPhrase } from "./use-held-phrase.ts";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { FromThreadLine } from "./from-thread-line.tsx";
import { part } from "@/lib/suit-part.ts";
import { SpadeBubbleText } from "./spade-bubble-text.tsx";
import { SpadeFold } from "./spade-fold.tsx";
import { botMessageBubble, botMinePalette, mineMessageBubble } from "./spade-bubble-style.ts";
import { BubbleFrame, NewDivider, SpeakerLine } from "./spade-chat-parts.tsx";
import {
  DocumentCard,
  SpadeReplyContext,
  type SpadeReactor,
  useReplies,
} from "./spade-chat-replies.tsx";
import { SpadeFace } from "./spade-face.tsx";
import { useMineAccent, useQuoteAccentResolver } from "./spade-accent.ts";
import {
  groupClubRows,
  isLongBubble,
  seqOfMessageId,
  type ClubBlock,
} from "./spade-chat-coalesce.ts";

/** A member as the chat shows it: its face, style, name, and its own chat when this window has it. */
export interface GroupFace {
  name: string;
  avatar: SpadeAvatar;
  style?: SpadeAgentStyle | undefined;
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
 * A club's conversation as a chat (ADR 0132): the person's pills on the right in the lead or
 * club's colour, each member's run on the left under one header (small face and name, with a
 * quiet `· answering <bot>` suffix on bot-to-bot relays instead of centered handoff lines), and
 * one reply turn coalesced into one soft block. Queued, failed or stopped asks stay quiet notes.
 */
export function SpadeGroupChat(props: {
  name: string;
  view: SpadeGroupView;
  /** The group's members, to find the one that waits for the person and resolve pill/reactor faces. */
  members: readonly SpadeGroupBot[];
  faceOf(bot: SpadeGroupBot): GroupFace;
  /** Reply to a message, the person's or a member's (ADR 0212 §4): the composer shows it. */
  onReply?: ((quote: SpadeQuote) => void) | undefined;
  /** React to any message in the club, or take the person's reaction back (undefined). */
  onReact?: ((message: string, emoji: string | undefined) => Promise<boolean>) | undefined;
  /** The last seen event sequence when opening an unread club, to place the NEW divider. */
  seenSeq?: number | undefined;
}) {
  const { view, members, faceOf } = props;
  const resolveQuoteAccent = useQuoteAccentResolver();
  // Pick the lead bot's colour if it has one, else the first coloured member's, for the user pill.
  const pillBot = useMemo(() => {
    for (const member of members) {
      const face = faceOf(member);
      if (resolveQuoteAccent(face)) return face;
    }
    return undefined;
  }, [members, faceOf, resolveQuoteAccent]);
  const mine = useMineAccent(pillBot);
  const reactorOf = useCallback(
    (id: string): SpadeReactor | undefined => {
      if (id === "person") return { name: "You" };
      const member = members.find((candidate) => candidate.id === id);
      if (member) {
        const face = faceOf(member);
        return { name: face.name, avatar: face.avatar };
      }
      return { name: id, avatar: parseSpadeAvatar(undefined, id) };
    },
    [members, faceOf],
  );
  // A club draws every row, so a quote's original is always on the page.
  const replies = useReplies(props.name, props.onReply, noop, view.reactions, props.onReact, {
    canReactOwn: true,
    reactorOf,
  });
  const blocks = useMemo(() => groupClubRows(view.rows), [view.rows]);
  const newBefore = useMemo(
    () => newClubDividerIndex(blocks, props.seenSeq),
    [blocks, props.seenSeq],
  );
  const waiting = view.state === "waiting";
  const waiter = spadeGroupWaiting(view, members);
  const shown = waiter ?? view.working;
  const working = shown ? faceOf(shown) : undefined;
  const phrase = useHeldPhrase(spadeWorkingPhrase(view.status));
  return (
    <SpadeReplyContext value={replies}>
      <div
        role="feed"
        aria-label={`Conversation in ${props.name}`}
        aria-busy={view.busy}
        style={mine}
        className={cn("flex flex-col", mine && botMinePalette)}
      >
        {blocks.map((block, index) => {
          const afterNew = newBefore === index;
          return (
            <div key={block.key} className="contents">
              {afterNew && <NewDivider />}
              <Block
                block={block}
                previous={afterNew ? undefined : blocks[index - 1]}
                faceOf={faceOf}
              />
            </div>
          );
        })}
        {view.busy && (
          <div role="status" className="mt-(--chat-turn-gap) flex items-center gap-2 first:mt-0">
            {working ? (
              <SpadeFace
                avatar={working.avatar}
                size={24}
                state={waiting ? "needs-you" : view.status === "Thinking" ? "thinking" : "working"}
              />
            ) : (
              <span aria-hidden className="size-6 shrink-0" />
            )}
            <span
              // Each new phrase sweeps once in the step's light, still under reduced motion.
              key={view.status === undefined ? undefined : phrase}
              className={cn(
                "min-w-0 truncate text-ui text-muted-foreground",
                view.status !== undefined && !waiting && "step-shimmer",
              )}
            >
              {view.status !== undefined
                ? phrase
                : working
                  ? waiting
                    ? `${working.name} is waiting for you`
                    : `${working.name} is answering`
                  : "Working"}
            </span>
            {waiter && working?.open && (
              <Button size="xs" variant="ghost" onClick={working.open}>
                {`Open ${working.name}`}
              </Button>
            )}
          </div>
        )}
      </div>
    </SpadeReplyContext>
  );
}

const noop = () => {};

/** First block strictly newer than `seenSeq`, once at least one older block preceded it. */
function newClubDividerIndex(blocks: readonly ClubBlock[], seenSeq: number | undefined): number {
  if (seenSeq === undefined || seenSeq <= 0) return -1;
  let hadSeen = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || block.kind === "line") continue;
    const ids =
      block.kind === "person"
        ? block.items.map((entry) => entry.row.id)
        : block.messages.flatMap((message) => message.ids);
    for (const id of ids) {
      const seq = seqOfMessageId(id);
      if (seq === undefined) continue;
      if (seq <= seenSeq) hadSeen = true;
      else if (hadSeen) return i;
    }
  }
  return -1;
}

/** 16px between turns, 20px above a new speaker header. */
function spaceAbove(block: ClubBlock, previous: ClubBlock | undefined): string {
  if (!previous) return "";
  if (block.kind === "member") return "mt-5";
  return "mt-(--chat-turn-gap)";
}

const Block = memo(function Block(props: {
  block: ClubBlock;
  previous: ClubBlock | undefined;
  faceOf(bot: SpadeGroupBot): GroupFace;
}) {
  const { block } = props;
  const space = spaceAbove(block, props.previous);
  switch (block.kind) {
    case "person":
      return (
        <div
          role="article"
          aria-label="You"
          className={cn("flex min-w-0 flex-col items-end gap-(--chat-run-gap)", space)}
        >
          {block.items.map(({ row, stack }, index) => {
            const long = isLongBubble(row.text);
            return (
              <div
                key={row.key}
                aria-busy={row.sending || undefined}
                className={cn(
                  "flex w-full flex-col items-end",
                  row.sending && "opacity-70",
                  row.quote && index > 0 && "mt-2",
                )}
              >
                {row.fromThread && <FromThreadLine thread={row.fromThread} />}
                <BubbleFrame
                  side="mine"
                  when={undefined}
                  copy={spadePlainText(row.text)}
                  speak={undefined}
                  quote={row.quote}
                  reply={
                    row.id && !row.sending
                      ? { id: row.id, who: { kind: "person" }, text: spadeQuoteLine(row.text) }
                      : undefined
                  }
                >
                  <div
                    {...part("spade-message", undefined, "user")}
                    className={mineMessageBubble(long, stack)}
                  >
                    <SpadeBubbleText text={row.text} side="mine" />
                  </div>
                </BubbleFrame>
              </div>
            );
          })}
        </div>
      );
    case "line":
      return (
        <p
          role="note"
          className={cn("text-center text-xs leading-4 text-subtle-foreground", space)}
        >
          {block.text}
        </p>
      );
    case "member": {
      const face = props.faceOf(block.bot);
      return (
        <div
          role="article"
          aria-label={face.name}
          className={cn("flex min-w-0 flex-col items-start gap-(--chat-run-gap)", space)}
        >
          <SpeakerLine
            avatar={face.avatar}
            name={face.name}
            detail={block.relayedBy ? `answering ${block.relayedBy}` : undefined}
          />
          {block.messages.map((message, index) => {
            const long = isLongBubble(message.text);
            const primaryId = message.ids[0];
            return (
              <BubbleFrame
                key={message.key}
                side="bot"
                when={undefined}
                copy={message.doc ? message.doc.text : spadePlainText(message.text)}
                speak={message.text || undefined}
                messageIds={message.ids}
                quote={message.quote}
                replier={face.name}
                className={message.quote && index > 0 ? "mt-2" : undefined}
                reply={
                  primaryId
                    ? {
                        id: primaryId,
                        who: { kind: "member", name: face.name },
                        text: spadeQuoteLine(message.text || message.doc?.title || ""),
                      }
                    : undefined
                }
              >
                {message.text && (
                  <div
                    {...part(
                      "spade-message",
                      undefined,
                      face.avatar.kind === "spade" ? "spade" : "bot",
                    )}
                    className={botMessageBubble(long, message.stack)}
                  >
                    <SpadeFold fold={message.fold}>
                      <SpadeBubbleText text={message.text} />
                    </SpadeFold>
                  </div>
                )}
                {message.doc && <DocumentCard doc={message.doc} />}
              </BubbleFrame>
            );
          })}
        </div>
      );
    }
  }
});
