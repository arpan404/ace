import type { AccessMode, Automation } from "@ace/protocol";
import { useId, useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { Composer } from "@/features/thread/index.ts";
import { AutomationAccess, AutomationModelChip } from "./run-settings.tsx";
import type { AutomationControls } from "./use-automation-controls.ts";

type ModelFields = Pick<Automation, "provider" | "model" | "effort" | "instance">;

/**
 * The conversation's composer, docked like a thread's: what is sent runs the automation now
 * with that note after its prompt. The access chip and model chip are the automation's own, and
 * changing either saves the automation. An agent's automation keeps the settings its thread gave
 * it, so its composer only runs it.
 */
export function ConversationComposer(props: {
  automation: Automation;
  controls: AutomationControls;
  runBlocked: string | undefined;
  settings: { onModel(fields: ModelFields): void; onAccess(access: AccessMode): void } | undefined;
}) {
  const { automation, controls, settings } = props;
  const reasonId = useId();
  const toast = useToast();
  const thread = useMemo(
    () => ({
      id: "",
      workspaceId: automation.workspace,
      title: "",
      draft: true,
      provider: automation.provider,
      instanceId: automation.instance,
    }),
    [automation.workspace, automation.provider, automation.instance],
  );
  const blocked =
    props.runBlocked ??
    (controls.pendingIntent
      ? "Retry the run that didn't start before sending another."
      : controls.busy
        ? "Starting the run…"
        : undefined);
  return (
    <>
      <Composer
        thread={thread}
        draftKey={`automation-note:${automation.id}`}
        busy={false}
        label="Note for this run"
        placeholder="Add a note and run it now"
        shortPlaceholder="Run it now"
        sendBlocked={blocked ? { reason: blocked, describedBy: reasonId } : undefined}
        onSubmit={async (draft) => {
          if (draft.files.local.length) {
            toast.error({ title: "A run takes a written note only. Remove the files to send it." });
            return false;
          }
          return controls.startRun(draft.text.trim() || undefined);
        }}
        controls={
          settings && (
            <AutomationAccess
              fields={automation}
              onChange={(access) => settings.onAccess(access)}
            />
          )
        }
        trailing={
          settings && (
            <AutomationModelChip
              fields={automation}
              onChange={(fields) => settings.onModel(fields)}
            />
          )
        }
      />
      {blocked && (
        <p id={reasonId} className="sr-only">
          {blocked}
        </p>
      )}
    </>
  );
}
