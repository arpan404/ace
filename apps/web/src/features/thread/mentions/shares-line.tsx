import { useThreadMeta } from "@ace/client-react";
import { sharesLine, sharesWords, type ComposerToken } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { chooseShare, useShareChoice } from "./share-choice.ts";

/**
 * Under the input while the message names a Spade bot or club (ADR 0194): exactly what goes to
 * them with it, in words, and the choice to send only the words. Nothing else is said.
 */
export function SharesLine(props: { threadId: string; tokens: readonly ComposerToken[] }) {
  const meta = useThreadMeta(props.threadId);
  const share = useShareChoice(props.threadId);
  const asked = props.tokens.some((token) => token.addressee && token.addressee.kind !== "agent");
  if (!asked) return null;
  const details = meta?.details;
  const words = sharesWords(
    {
      project: details?.workspace?.kind === "chat" ? undefined : details?.workspace?.name,
      branch: details?.branch ?? undefined,
      pullRequest: details?.linkedPr?.number,
      files: props.tokens.filter((token) => token.file).length,
    },
    share,
  );
  return (
    <p
      data-part="composer-shares"
      className="flex min-w-0 items-center gap-2 px-4 pb-1 text-xs text-muted-foreground"
    >
      <span className="min-w-0 truncate">{sharesLine(words)}</span>
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0"
        onClick={() => chooseShare(props.threadId, share === "thread" ? "message" : "thread")}
      >
        {share === "thread" ? "Share only this message" : "Share the thread too"}
      </Button>
    </p>
  );
}
