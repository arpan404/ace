import { useClient, useItem, useThreadMeta } from "@ace/client-react";
import { ThreadId, type ContentPart, type Item } from "@ace/protocol";
import { describeProviderError } from "@ace/ui-core";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { ErrorRow, noticeError } from "../items/error-row.tsx";
import type { Failure } from "./turn-end.tsx";

/** The person's message again, as input: its text, images and files. */
function resend(item: Item | undefined): ContentPart[] {
  if (item?.type !== "message") return [];
  return item.parts.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : part,
  );
}

/** Actions that fix the failure where it is; Retry would only fail again. */
const fixes = new Set(["sign_in", "switch_account", "change_model"]);

/**
 * A failed turn as one row: the failure in words from the notice that reported it, else from the
 * run, else from the agent while the turn was its latest; the action that fixes it (sign in,
 * another account, another model), or Retry on the newest turn; the provider's text in Details.
 */
export function FailedTurn(props: {
  threadId: string;
  askId: string | undefined;
  errorId: string | undefined;
  error: Failure | undefined;
  latest: boolean;
}) {
  const { error, latest } = props;
  const provider = useThreadMeta(props.threadId)?.provider;
  const ask = useItem(props.threadId, props.askId ?? "");
  const notice = useItem(props.threadId, props.errorId ?? "");
  const client = useClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const input = resend(ask);
  const reported = notice?.type === "notice" ? noticeError(notice) : undefined;
  const view = describeProviderError(
    reported
      ? { ...reported, provider: reported.provider ?? provider }
      : {
          text: error?.message ?? "",
          kind: error?.kind,
          provider,
          // Details names the failure's kind as the daemon reported it.
          detail: error ? `${error.kind}: ${error.message}` : undefined,
        },
  );
  const retry = async () => {
    setSending(true);
    try {
      await client.enqueue({
        type: "thread.send",
        threadId: ThreadId.parse(props.threadId),
        input,
        trigger: "user",
      });
    } catch {
      toast.add({ title: "Couldn't retry the turn" });
    } finally {
      setSending(false);
    }
  };
  const fixable = latest && view.action !== undefined && fixes.has(view.action);
  // Nothing said why: "Turn failed" alone. A fix names the failure itself ("Not signed in").
  const known = reported !== undefined || error !== undefined;
  const failed = known ? view : { title: "Turn failed" };
  return (
    <ErrorRow
      error={fixable ? failed : { ...failed, action: undefined }}
      heading={fixable || !known ? undefined : "Turn failed"}
      onRetry={latest && input.length > 0 && !fixable ? () => void retry() : undefined}
      retrying={sending}
    />
  );
}
