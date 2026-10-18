import { useClient, useItem, useThreadMeta } from "@ace/client-react";
import { describeProviderError, displayNotice, isLimitError, modelLabel } from "@ace/ui-core";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { ErrorRow, noticeError } from "../items/error-row.tsx";
import { resendPayload } from "../transitions/resend.ts";
import type { Failure } from "./failure.ts";

/** Whether the provider's text says only what the row already says, perhaps after a label. */
function repeats(raw: string, shown: { title: string; message?: string | undefined }): boolean {
  const text = raw.trim();
  return [shown.message, shown.title].some(
    (said) => !!said && (text === said || text.endsWith(`: ${said}`)),
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
  const original = notice?.type === "notice" ? noticeError(notice) : undefined;
  const display = notice?.type === "notice" ? displayNotice(notice) : undefined;
  const reported = original
    ? {
        ...original,
        text: display?.text ?? "",
        title: display?.title,
        code: display?.code,
        detail: display?.detail,
      }
    : undefined;
  const described = describeProviderError(
    reported
      ? { ...reported, provider: reported.provider ?? provider, model: reported.model ?? model }
      : {
          text: error?.message ?? "",
          kind: error?.kind,
          provider,
          model,
          // Details names the failure's kind as the daemon reported it.
          detail: error ? `${error.kind}: ${error.message}` : undefined,
        },
  );
  // Native tagged text must not classify or replace the diagnostic's reviewed wording. Details
  // only says what the summary doesn't: never the same words again ("provider: " before them).
  const raw = original ? (original.detail ?? original.text) : described.raw;
  const view = { ...described, raw: raw && !repeats(raw, described) ? raw : undefined };
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
  const fixable = latest && view.action !== undefined && fixes.has(view.action);
  // Nothing said why: "Turn failed" alone. A fix names the failure itself ("Not signed in").
  const known = reported !== undefined || error !== undefined;
  // A limit names itself ("Usage limit reached · Resets 8:30pm"), never "Turn failed".
  const heading = fixable || !known || isLimitError(view) ? undefined : "Turn failed";
  // Under "Turn failed" the failure's own words follow the model, even when they were its title.
  const said = heading ? (view.message ?? view.title) : view.message;
  const failed = known
    ? {
        ...view,
        message:
          [model && view.code !== "model_not_found" ? modelLabel(model) : undefined, said]
            .filter(Boolean)
            .join(" · ") || undefined,
      }
    : { title: "Turn failed" };
  return (
    <ErrorRow
      error={fixable ? failed : { ...failed, action: undefined }}
      heading={heading}
      onRetry={latest && payload && !fixable ? () => void retry() : undefined}
      retrying={sending}
    />
  );
}
