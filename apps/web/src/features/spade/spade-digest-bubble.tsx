import { spadeDigestMessage, type SpadeAvatar, type SpadeDigest } from "@ace/ui-core/spade-chat";
import { cn } from "@/lib/cn.ts";
import { chatBubble, framed } from "./spade-bubble-style.ts";
import { BubbleFrame } from "./spade-chat-parts.tsx";
import { SpadeFace } from "./spade-face.tsx";

/**
 * A digest (ADR 0165) as a message of the bot's, read like any reply: the goal and how much of
 * it is verified, what changed, what waits on the person and what it decided for them, then one
 * line per worker with its face, and what it spent and does next. Spend is plain information.
 */
export function SpadeDigestBubble(props: {
  digest: SpadeDigest;
  when: string | undefined;
  face(bot: string): SpadeAvatar;
}) {
  const message = spadeDigestMessage(props.digest);
  const copy = [
    message.heading,
    ...message.lines,
    ...message.workers.map((worker) => `${worker.name}${worker.line}`),
    message.close,
    message.plain,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <BubbleFrame side="bot" when={props.when} copy={copy} speak={copy}>
      <div
        role="article"
        aria-label="Digest"
        className={cn(chatBubble, framed, "flex flex-col gap-2")}
      >
        {message.heading && <p className="font-semibold text-foreground">{message.heading}</p>}
        {message.lines.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {message.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
        {message.workers.length > 0 && (
          <>
            <p className="font-semibold text-foreground">Workers</p>
            <ul aria-label="Workers" className="flex flex-col gap-1.5">
              {message.workers.map((worker) => (
                <li key={worker.agent || worker.name} className="flex items-start gap-2">
                  <SpadeFace avatar={props.face(worker.agent)} size={20} className="mt-0.5" />
                  <span>
                    <strong className="font-semibold">{worker.name}</strong>
                    {worker.line}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {message.close && <p>{message.close}</p>}
        {message.plain && <p className="whitespace-pre-wrap">{message.plain}</p>}
      </div>
    </BubbleFrame>
  );
}
