import { useClient, useItem } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { parseSpadeAvatar } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { MentionFace } from "@/lib/spade-mentions.tsx";

/**
 * A Spade bot's reply in the thread (ADR 0198): its face and name (and its club), then its words,
 * streaming while it writes them. Never the agent's: the agent is given it, marked untrusted,
 * with the person's next message. Reply asks the bot again, about the same message, with the
 * thread's context as before; only the bot gets it.
 */
export function BotReply(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const client = useClient();
  const toast = useToast();
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const message = item?.type === "message" ? item : undefined;
  const speaker = message?.speaker;
  if (!message || !speaker) return null;
  const words = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const streaming = !message.complete;
  const send = () => {
    const said = text.trim();
    if (!said) return;
    setReplying(false);
    setText("");
    void client
      .command({
        type: "thread.address",
        threadId: ThreadId.parse(props.threadId),
        about: speaker.about,
        input: [{ type: "text", text: `@${speaker.club?.name ?? speaker.name} ${said}` }],
        to: [
          speaker.club
            ? {
                kind: "club",
                id: speaker.club.id,
                name: speaker.club.name,
                faces: [],
                ...(speaker.machine ? { machine: speaker.machine } : {}),
              }
            : {
                kind: "bot",
                id: speaker.id,
                name: speaker.name,
                ...(speaker.avatar !== undefined ? { avatar: speaker.avatar } : {}),
                ...(speaker.machine ? { machine: speaker.machine } : {}),
              },
        ],
        devices: [],
        share: "thread",
        files: [],
        followUp: true,
      })
      .then((result) => {
        if (!result.ok) throw new Error(result.error);
      })
      .catch(() =>
        toast.error({ title: "Reply not sent", description: `${speaker.name} didn't get it.` }),
      );
  };
  return (
    <div data-part="bot-reply" className="flex min-w-0 gap-2.5">
      <MentionFace
        avatar={parseSpadeAvatar(speaker.avatar, speaker.id)}
        size={24}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{speaker.name}</span>
          {speaker.club && <span> in {speaker.club.name}</span>}
          {speaker.machine && <span> on {speaker.machine.name}</span>}
        </p>
        <div className="font-prose text-prose leading-[1.6] wrap-break-word">
          <Prose
            text={words}
            stream={`${props.threadId}/${props.itemId}`}
            streaming={streaming}
            thread={{ threadId: props.threadId, itemId: message.id }}
          />
        </div>
        {!streaming &&
          (replying ? (
            <form
              className="mt-1.5 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <input
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by the person's Reply
                autoFocus
                aria-label={`Reply to ${speaker.name}`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setReplying(false);
                }}
                className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-ui outline-none focus-visible:border-ring"
              />
              <Button size="xs" type="submit" disabled={!text.trim()}>
                Send
              </Button>
            </form>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              className="-ml-1.5 mt-0.5"
              onClick={() => setReplying(true)}
            >
              Reply
            </Button>
          ))}
      </div>
    </div>
  );
}
