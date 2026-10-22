import { useNavigate } from "@tanstack/react-router";
import type { ForgePrDetail } from "@ace/protocol";
import { insertTextInComposer, insertTextWhenMounted } from "@/lib/composer-insert.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { fixRequest, type AttentionItem } from "./pr-summary-model.ts";

/**
 * "Fix with agent": the request goes into the composer of the task working on this PR (the
 * one showing it, else the first linked), for the person to read over and send. Nothing is
 * sent on their behalf. With no linked task, a new task starts from the PR.
 */
export function useFixWithAgent(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  hostThreadId?: string | undefined;
}) {
  const navigate = useNavigate();
  const workspace = useWorkspaceActions(props.hostThreadId ?? "");
  const toast = useToast();
  const { detail } = props;
  const linked = detail.relatedThreads.filter((thread) => !thread.archived);
  const target = linked.find((thread) => thread.id === props.hostThreadId) ?? linked[0];
  /** Put `request` in the composer of the task working on this PR, for the person to send. */
  const ask = (request: string) => {
    if (!target) {
      void navigate({
        to: "/new",
        search: { project: props.workspaceId, pullRequest: detail.status.url },
      });
      return;
    }
    // The panel's own task: a panel in full view hides its composer, so step out of it.
    const here = target.id === props.hostThreadId;
    if (here) workspace.setExpanded(false);
    // The request showing in the composer is the confirmation.
    if (insertTextInComposer(target.id, request)) return;
    if (!here) void navigate({ to: "/t/$threadId", params: { threadId: target.id } });
    // The task's composer mounts once its page shows; hand the request over then.
    void insertTextWhenMounted(target.id, request).then((inserted) => {
      if (!inserted)
        toast.error({
          title: "Couldn't add the request",
          description: "Open the task and try again.",
        });
    });
  };
  return {
    /** The task the request goes to, if one is linked. */
    target,
    ask,
    fix(item: AttentionItem) {
      ask(fixRequest(item, { number: detail.status.ref.number, url: detail.status.url }));
    },
  };
}
