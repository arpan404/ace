import { useNavigate } from "@tanstack/react-router";
import type { ForgePrDetail } from "@ace/protocol";
import { insertTextInComposer, insertTextWhenMounted } from "@/lib/composer-insert.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { fixRequest, type AttentionItem } from "./pr-summary-model.ts";
import { useMachineSearch } from "@/lib/machine-routes.ts";
import { recordFixMark } from "./pr-fix-marks.ts";
import { useClock } from "@/lib/time.ts";

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
  const machine = useMachineSearch();
  const workspace = useWorkspaceActions(props.hostThreadId ?? "");
  const toast = useToast();
  const now = useClock();
  const { detail } = props;
  const linked = detail.relatedThreads.filter((thread) => !thread.archived);
  const target = linked.find((thread) => thread.id === props.hostThreadId) ?? linked[0];
  const prKey = JSON.stringify(detail.status.ref);
  /**
   * Put `request` in the composer of the task working on this PR, for the person to send.
   * `subject` (`thread:<id>` or `check:<id>`) is what it came from, which then shows "Agent
   * fixing this" while that task works, until it pushes and replies.
   */
  const ask = (request: string, subject?: string) => {
    if (!target) {
      void navigate({
        to: "/new",
        search: { project: props.workspaceId, pullRequest: detail.status.url, ...machine },
      });
      return;
    }
    if (subject)
      recordFixMark(
        { workspaceId: props.workspaceId, prKey, url: detail.status.url },
        {
          subject,
          agentThreadId: target.id,
          headSha: detail.status.headSha,
          at: new Date(now()).toISOString(),
        },
        detail.status,
        now(),
      );
    // The panel's own task: a panel in full view hides its composer, so step out of it.
    const here = target.id === props.hostThreadId;
    if (here) workspace.setExpanded(false);
    // The request showing in the composer is the confirmation.
    if (insertTextInComposer(target.id, request)) return;
    if (!here)
      void navigate({ to: "/t/$threadId", params: { threadId: target.id }, search: machine });
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
      ask(fixRequest(item, { number: detail.status.ref.number, url: detail.status.url }), item.key);
    },
  };
}
