import { BellIcon } from "@ace/icons";
import { spadeNoticeWords, type SpadeBubble } from "@ace/ui-core/spade-chat";
import { botBubble } from "./spade-card.tsx";
import { cn } from "@/lib/cn.ts";

type Notice = Extract<SpadeBubble, { kind: "notice" }>;

/**
 * A notice the bot sent the person (`notify`, ADR 0200 §4.2), where it sent it: the bot's bubble
 * with a bare bell, the title and body as plain text (the bot's words: nothing in them is a link
 * or opens anything), and one quiet line saying what became of it: sent as a notification, held
 * for the morning brief and why, or not sent.
 */
export function SpadeNoticeRow(props: { item: Notice; botName: string }) {
  const { item } = props;
  return (
    <div
      role="group"
      aria-label={`${props.botName} sent a notice: ${item.title}`}
      className={cn(botBubble, "flex flex-col gap-1")}
    >
      <span className="flex min-w-0 items-center gap-2 font-medium">
        <BellIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 whitespace-pre-wrap">{item.title}</span>
      </span>
      {item.body && <p className="whitespace-pre-wrap">{item.body}</p>}
      <span className="text-ui text-muted-foreground">{spadeNoticeWords(item)}</span>
    </div>
  );
}
