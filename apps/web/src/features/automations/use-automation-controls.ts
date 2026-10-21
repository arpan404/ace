import type { Automation } from "@ace/protocol";
import { useConnectionState } from "@ace/client-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { entrySource, type AutomationEntry } from "@/features/automation-data/index.ts";
import { runSummary } from "./labels.ts";
import { staleDeleteMessage, staleWriteMessage } from "@/features/automation-data/index.ts";
import { clearRunIntent, ensureRunIntent, getRunIntent } from "@/features/automation-data/index.ts";
import { useAutomationActions, useAutomationLists } from "@/features/automation-data/index.ts";

/**
 * Everything the conversation does to its automation: run it (with a note), pause or resume,
 * save a change (rename, model, access) against the revision on screen, duplicate and delete
 * with Undo. One write at a time; none while disconnected. A run is a durable intent first, so
 * an uncertain send retries with the same key and note instead of starting a second run.
 */
export function useAutomationControls(
  entry: AutomationEntry,
  daemonKey: string,
  refetch: () => void,
) {
  const { storage } = useLayout();
  const navigate = useNavigate();
  const router = useRouter();
  const ready = useConnectionState() === "ready";
  const { setEnabled, remove, runNow, save } = useAutomationActions();
  const lists = useAutomationLists().data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  const automationId = entry.automation.id;
  const source = entrySource(entry);
  const [runError, setRunError] = useState<string | undefined>();
  const [pendingIntent, setPendingIntent] = useState(() =>
    getRunIntent(storage, daemonKey, automationId),
  );
  const failed = (error: unknown) =>
    toast.error({
      title:
        error instanceof Error
          ? error.message
          : "Couldn't connect. Try again once the connection is back.",
    });

  const guard = () => {
    if (busyRef.current || !ready) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  };
  const release = () => {
    busyRef.current = false;
    if (liveRef.current) setBusy(false);
  };

  /**
   * Run now, with `message` added after the prompt for this run only. Resolves true once the
   * run is either admitted or kept as a durable intent to retry; false when nothing was kept.
   */
  const startRun = (message?: string): Promise<boolean> => {
    if (!guard()) return Promise.resolve(false);
    const intent = ensureRunIntent(
      storage,
      daemonKey,
      automationId,
      () => Date.now(),
      () => crypto.randomUUID(),
      message,
    );
    if (!intent) {
      release();
      if (liveRef.current) setRunError("Couldn't save the run request. Try again.");
      return Promise.resolve(false);
    }
    if (liveRef.current) {
      setPendingIntent(intent);
      setRunError(undefined);
    }
    return runNow(automationId, { requestId: intent.requestId, message: intent.message, source })
      .then(
        (run) => {
          clearRunIntent(storage, daemonKey, automationId);
          release();
          if (!liveRef.current) return;
          setPendingIntent(undefined);
          if (run.status !== "running") setRunError(runSummary(run));
          refetch();
        },
        (error: unknown) => {
          release();
          if (!liveRef.current) return;
          setPendingIntent(getRunIntent(storage, daemonKey, automationId));
          setRunError(
            error instanceof Error
              ? error.message
              : "Couldn't start the run. Retry with the same request.",
          );
          refetch();
        },
      )
      .then(() => true);
  };

  /** Store a changed definition against the revision on screen; a conflict is told, not lost. */
  const update = (next: Automation): Promise<boolean> => {
    if (!guard()) return Promise.resolve(false);
    return save(next, entry.revision).then(
      () => {
        release();
        refetch();
        return true;
      },
      (error: unknown) => {
        release();
        if (liveRef.current) failed(new Error(staleWriteMessage(error)));
        refetch();
        return false;
      },
    );
  };

  return {
    busy,
    ready,
    source,
    pendingIntent,
    runError,
    startRun,
    update,
    toggle(enabled: boolean) {
      if (!guard()) return;
      setEnabled(automationId, enabled, entry.revision, source)
        .then(() => refetch())
        .catch((error: unknown) => {
          if (liveRef.current) failed(new Error(staleWriteMessage(error)));
          refetch();
        })
        .finally(release);
    },
    duplicate() {
      if (!guard()) return;
      const copy = {
        ...entry.automation,
        id: `auto-${crypto.randomUUID()}`,
        title: `${entry.automation.title.slice(0, 251)} copy`,
        enabled: false,
      };
      save(copy, null).then(
        () => {
          release();
          if (!liveRef.current) return;
          void navigate({
            to: "/automations/$automationId/edit",
            params: { automationId: copy.id },
          });
        },
        (error: unknown) => {
          release();
          if (liveRef.current) failed(new Error(staleWriteMessage(error)));
        },
      );
    },
    remove() {
      if (!guard()) return;
      const { automation, revision } = entry;
      const ids = [...(lists?.person ?? []), ...(lists?.threads ?? [])].map(
        (candidate) => candidate.automation.id,
      );
      const at = ids.indexOf(automation.id);
      const next = ids[at + 1] ?? ids[at - 1];
      remove(automation.id, revision, source).then(
        () => {
          clearRunIntent(storage, daemonKey, automation.id);
          release();
          toast.add({
            title: `Deleted · ${automation.title}`,
            // Undo recreates the person's own automation; a thread's belongs to its thread.
            ...(source === "person"
              ? {
                  undo: () => {
                    save(automation, null).then(
                      () => refetch(),
                      (error: unknown) => failed(new Error(staleWriteMessage(error))),
                    );
                  },
                }
              : {}),
          });
          if (
            router.state.location.pathname !== `/automations/${encodeURIComponent(automation.id)}`
          )
            return;
          void navigate(
            next && next !== automation.id
              ? { to: "/automations/$automationId", params: { automationId: next } }
              : { to: "/automations" },
          );
        },
        (error: unknown) => {
          release();
          if (!liveRef.current) return;
          failed(new Error(staleDeleteMessage(error)));
          refetch();
        },
      );
    },
  };
}

export type AutomationControls = ReturnType<typeof useAutomationControls>;
