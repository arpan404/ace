import { useNavigate } from "@tanstack/react-router";
import type { ForgePrRow } from "@ace/protocol";
import {
  type LocalCheckResult,
  type PrNextStep,
  type LinkedThread,
  agentRequest,
} from "@ace/ui-core";
import { useToast } from "@/components/ui/toast.tsx";
import { insertTextWhenMounted } from "@/lib/composer-insert.ts";

/**
 * What each step's button does from the list: Answer opens the thread, Review the PR's code,
 * Update its page (where the update lives), and Fix, Address and Resolve hand the PR to its
 * thread's agent, as a request in that thread's composer to read over and send, or to a new
 * thread when none is linked.
 */
export function useStepAction(back: string) {
  const navigate = useNavigate();
  const toast = useToast();
  const openPr = (project: string, row: ForgePrRow, tab?: "code") =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(row.ref.number) },
      search: { back, ...(tab ? { tab } : {}) },
    });
  return (input: {
    project: string;
    step: PrNextStep;
    row: ForgePrRow;
    thread: LinkedThread | undefined;
    local: LocalCheckResult;
    command: string | null | undefined;
  }) => {
    const { project, step, row, thread } = input;
    if (step === "answer" && thread) {
      void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
      return;
    }
    if (step === "review") return openPr(project, row, "code");
    const request = agentRequest(step, row, input.local, input.command);
    if (!request) return openPr(project, row);
    if (!thread) {
      void navigate({ to: "/new", search: { project, pullRequest: row.url } });
      return;
    }
    void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    void insertTextWhenMounted(thread.id, request).then((inserted) => {
      if (!inserted)
        toast.error({
          title: "Couldn't add the request",
          description: "Open the thread and try again.",
        });
    });
  };
}
