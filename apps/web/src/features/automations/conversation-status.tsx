import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import type { AutomationEntry } from "@/features/automation-data/index.ts";
import { answer, TextAction, TurnDivider } from "./conversation-runs.tsx";
import { staleWriteMessage } from "@/features/automation-data/index.ts";
import { formatWhen } from "@/features/automation-schedule/index.ts";
import { githubHint, triggerErrorCopy } from "@/features/automation-data/index.ts";
import type { AutomationControls } from "./use-automation-controls.ts";
import { useAutomationActions } from "@/features/automation-data/index.ts";

const dot = (
  <span aria-hidden className="text-faint-foreground">
    {" · "}
  </span>
);

/**
 * What stands after the last run when something needs the person: a trigger that stopped
 * watching, a GitHub check that failed, or a run that didn't start. Each is one sentence with
 * text actions, as a turn of the conversation.
 */
export function ConversationStatus(props: {
  entry: AutomationEntry;
  controls: AutomationControls;
  runBlocked: string | undefined;
  /** Opens when it runs, in place in the composer's strip. */
  onEditWhen(): void;
}) {
  const { entry, controls } = props;
  const now = useNow();
  const own = controls.source === "person";
  const { automation } = entry;
  const editWhen = own && (
    <TextAction strong onClick={props.onEditWhen}>
      Edit when
    </TextAction>
  );
  return (
    <>
      {entry.triggerError ? (
        <section role="alert" aria-label="Trigger" className="mt-10 flex flex-col gap-3">
          <TurnDivider
            status={{ tone: "failed", word: "Not watching" }}
            when={`since ${formatWhen(entry.triggerError.at, now)}`}
          />
          <p className={answer}>
            {triggerErrorCopy(automation.trigger, entry.triggerError)} {editWhen}
            {own && (
              <>
                {dot}
                <RetryTrigger entry={entry} busy={controls.busy} />
              </>
            )}
          </p>
        </section>
      ) : (
        entry.lastPollError && (
          <section role="alert" aria-label="GitHub check" className="mt-10 flex flex-col gap-3">
            <TurnDivider
              status={{ tone: "failed", word: "Couldn't check GitHub" }}
              when={`since ${formatWhen(entry.lastPollError.at, now)}`}
            />
            <p className={answer}>
              {githubHint(entry.lastPollError.message)} {editWhen}
            </p>
          </section>
        )
      )}
      {(controls.pendingIntent || controls.runError) && (
        <section role="alert" aria-label="Run now" className="mt-10 flex flex-col gap-3">
          <TurnDivider
            status={{ tone: "failed", word: "Not started" }}
            when={formatWhen(controls.pendingIntent?.createdAt ?? now, now)}
          />
          <p className={answer}>
            {controls.runError ?? "Couldn't confirm the run started."}{" "}
            {controls.pendingIntent && (
              <TextAction
                strong
                disabled={!!props.runBlocked || controls.busy}
                onClick={() => void controls.startRun()}
              >
                Retry run
              </TextAction>
            )}
          </p>
        </section>
      )}
    </>
  );
}

/** Start the stopped trigger again from the stored definition at this revision. */
function RetryTrigger(props: { entry: AutomationEntry; busy: boolean }) {
  const { retry } = useAutomationActions();
  const toast = useToast();
  const [retrying, setRetrying] = useState(false);
  return (
    <TextAction
      disabled={props.busy || retrying}
      onClick={() => {
        setRetrying(true);
        retry(props.entry.automation.id, props.entry.revision).then(
          () => setRetrying(false),
          (error: unknown) => {
            setRetrying(false);
            toast.error({ title: staleWriteMessage(error) });
          },
        );
      }}
    >
      Retry
    </TextAction>
  );
}
