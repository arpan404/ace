import { useClient, useItem, useThreadMeta } from "@ace/client-react";
import { failedTurnView } from "@ace/ui-core";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { ErrorRow } from "../items/error-row.tsx";
import { resendPayload } from "../transitions/resend.ts";
import type { Failure } from "./failure.ts";

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
  /** The thread's composer strip already says a usage or rate limit: no row for it here. */
  limitInStrip?: boolean | undefined;
}) {
  const { error, latest } = props;
  const thread = useThreadMeta(props.threadId);
  const provider = thread?.provider;
  const ask = useItem(props.threadId, props.askId ?? "");
  const notice = useItem(props.threadId, props.errorId ?? "");
  const model =
    notice?.executionSource?.selection.model ??
    ask?.executionSource?.selection.model ??
    (latest ? thread?.execution?.model : undefined);
  const client = useClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const payload = resendPayload(props.threadId, ask);
  const shown = failedTurnView({
    notice,
    error,
    provider,
    model,
    latest,
  });
  const retry = async () => {
    if (!payload) return;
    setSending(true);
    try {
      await client.enqueue(payload);
    } catch {
      toast.error({ title: "Couldn't retry the turn" });
    } finally {
      setSending(false);
    }
  };
  if (props.limitInStrip && shown.limit) return null;
  return (
    <ErrorRow
      error={shown.error}
      heading={shown.heading}
      onRetry={latest && payload && !shown.fixable ? () => void retry() : undefined}
      retrying={sending}
    />
  );
}
