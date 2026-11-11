import {
  spadeCallLine,
  spadeToolWords,
  type SpadeEntry,
  type SpadeImageRef,
  type SpadeReplyEntry,
  type SpadeView,
} from "@ace/ui-core/spade-chat";
import { memo } from "react";
import { formatBytes } from "@/components/format-bytes.ts";
import { sentImageUrl } from "./spade-images.ts";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { WorkingIndicator } from "@/components/working-indicator.tsx";
import { BubbleText, userBubble } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";

const answerText =
  "min-w-0 font-prose text-prose leading-[1.6] tracking-[-0.005em] wrap-break-word";
const quiet = "text-ui text-muted-foreground";

/**
 * A conversation's entries in order: the person's bubbles on the right, Spade's words as prose,
 * each tool call it made as one quiet line once it has an outcome (the Working line names the one
 * running), how a reply ended when it didn't finish, a background job's end, and a quiet line
 * where the conversation was compacted. The Working line, with Stop, closes the open reply.
 */
export function SpadeTranscript(props: {
  conversation: string;
  view: SpadeView;
  onStop: () => void;
  stopping: boolean;
}) {
  const { view } = props;
  return (
    <div
      role="feed"
      aria-label="Conversation"
      aria-busy={view.busy}
      className="flex flex-col gap-6"
    >
      {view.entries.map((entry) => (
        <Entry key={entry.key} entry={entry} conversation={props.conversation} />
      ))}
      {view.working && (
        <p role="status" className={cn("flex items-center gap-2", quiet)}>
          <WorkingIndicator
            label={view.working.label}
            from={view.working.since}
            moving={view.working.moving}
          />
          {view.answering && (
            <Button
              size="xs"
              variant="ghost"
              disabled={props.stopping}
              aria-label="Stop Spade's reply"
              onClick={props.onStop}
            >
              {props.stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
        </p>
      )}
    </div>
  );
}

const Entry = memo(function Entry(props: { entry: SpadeEntry; conversation: string }) {
  const { entry } = props;
  switch (entry.kind) {
    case "user":
      return (
        <div
          role="article"
          className={cn("flex flex-col items-end gap-1", entry.pending && "opacity-70")}
          aria-busy={entry.pending}
        >
          {entry.images.length > 0 && <SentImages images={entry.images} />}
          {entry.text && (
            <div className={userBubble}>
              <BubbleText text={entry.text} />
            </div>
          )}
        </div>
      );
    case "reply":
      return <Reply entry={entry} conversation={props.conversation} />;
    case "compacted":
      return (
        <p role="note" className="text-center text-meta text-muted-foreground">
          Earlier messages are summarized for Spade
        </p>
      );
    case "job":
      return (
        <p className={quiet}>
          {entry.failed
            ? `Couldn't ${spadeToolWords(entry.name).base} in the background`
            : `${spadeToolWords(entry.name).done} in the background`}
        </p>
      );
  }
});

/**
 * The person's images, right-aligned above their words. One sent from this window shows itself;
 * one sent elsewhere is a quiet tile with its size, since the daemon can't fetch Spade's copy yet.
 */
function SentImages(props: { images: readonly SpadeImageRef[] }) {
  return (
    <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
      {/* The same image twice in one message is one picture shown twice: keyed by place. */}
      {props.images
        .map((image, place) => ({ image, key: `${place}:${image.sha256}` }))
        .map(({ image, key }) => {
          const url = sentImageUrl(image.sha256);
          return url ? (
            <img key={key} src={url} alt="" className="max-h-40 max-w-60 rounded-lg object-cover" />
          ) : (
            <span
              key={key}
              className="grid h-16 min-w-24 place-items-center rounded-lg bg-bubble px-3 text-xs text-muted-foreground"
            >
              {`Image · ${formatBytes(image.bytes)}`}
            </span>
          );
        })}
    </div>
  );
}

/** Calls that read in the transcript: ones with an outcome. */
const settled = new Set(["done", "failed", "declined", "skipped"]);

function Reply(props: { entry: SpadeReplyEntry; conversation: string }) {
  const { entry } = props;
  const stream = `spade/${props.conversation}/${entry.key}`;
  return (
    <div role="article" className="flex flex-col gap-3">
      {entry.parts.map((part) =>
        part.kind === "text" ? (
          <div key={part.key} className={answerText} data-quotable="">
            <Prose text={part.text} />
          </div>
        ) : settled.has(part.state) ? (
          <p key={part.key} className={cn(quiet, part.state === "failed" && "text-status-failed")}>
            {spadeCallLine(part.name, part.state)}
          </p>
        ) : null,
      )}
      {entry.live && (
        <div className={answerText}>
          <Prose text={entry.live} stream={stream} streaming />
        </div>
      )}
      {entry.end && entry.end.kind !== "finished" && <ReplyEnd end={entry.end} />}
    </div>
  );
}

function ReplyEnd(props: {
  end: Exclude<SpadeReplyEntry["end"], undefined | { kind: "finished" }>;
}) {
  const { end } = props;
  if (end.kind === "failed")
    return (
      <p role="alert" className="text-ui text-status-failed">
        {end.error ? `Spade couldn't finish. ${capitalised(end.error)}` : "Spade couldn't finish."}
      </p>
    );
  return (
    <p className={quiet}>
      {end.kind === "stopped" ? "Stopped" : "Interrupted when Spade restarted"}
    </p>
  );
}

const capitalised = (text: string) => {
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
};
