import { useClient } from "@ace/client-react";
import type { ForgePrRef } from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { useState } from "react";
import { InlineMarkdown } from "@/components/inline-markdown.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";

/**
 * A reply to a review comment that mentioned you, posted in its thread on the forge (↵ sends).
 * The daemon answers with the PR's fresh status, which the feed reads on its next pass.
 */
export function MentionReply(props: {
  author: string;
  target: { threadId: string; pr: ForgePrRef; commentId: number };
}) {
  const client = useClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const send = () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    void client
      .command({
        type: "forge.comment.reply",
        link: { threadId: props.target.threadId, pr: props.target.pr },
        commentId: props.target.commentId,
        body,
      })
      .then(
        (result) => {
          setSending(false);
          if (!result.ok) return setError(actionErrorText(result.error));
          setText("");
          setError(undefined);
          toast.add({ title: `Replied to ${props.author}` });
        },
        () => {
          setSending(false);
          setError(actionErrorText(undefined));
        },
      );
  };
  return (
    <>
      <Input
        aria-label={`Reply to ${props.author}`}
        placeholder={`Reply to ${props.author}…`}
        value={text}
        maxLength={65_536}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
        className="mt-3"
      />
      {error && (
        <p role="alert" className="mt-1 text-sm text-status-failed">
          <InlineMarkdown text={error} />
        </p>
      )}
    </>
  );
}
