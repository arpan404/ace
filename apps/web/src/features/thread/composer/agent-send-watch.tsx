import { useIntent } from "@ace/client-react";
import type { CommandPayload } from "@ace/protocol";
import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { sendFailure } from "../items/send-failure.ts";
import { draftOf } from "./returned-draft.ts";
import { returnDraft } from "./send-store.ts";

/**
 * Watches the last follow-up sent to one agent of the tree (UX audit SY-3): if the daemon
 * refuses it, a toast says why and Edit puts it back in that agent's composer.
 */
export function AgentSendWatch(props: {
  commandId: string;
  payload: Extract<CommandPayload, { type: "thread.send" }>;
  draftKey: string;
}) {
  const toast = useToast();
  const announced = useRef<string | undefined>(undefined);
  const intent = useIntent(props.commandId);
  const failed = intent?.state === "failed";
  const error = intent?.error;
  const { payload, draftKey } = props;
  useEffect(() => {
    if (!failed || announced.current === props.commandId) return;
    announced.current = props.commandId;
    toast.error({
      eventId: `send-failed:${props.commandId}`,
      kind: "send-failed",
      title: "Follow-up not sent",
      description: sendFailure(error, payload),
      actionProps: { children: "Edit", onClick: () => returnDraft(draftKey, draftOf(payload)) },
    });
  }, [failed, error, payload, draftKey, toast, props.commandId]);
  return null;
}
