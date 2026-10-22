import { useThreadMeta } from "@ace/client-react";
import { ScreenInventory, ScreenState, type ScreenTarget } from "@ace/protocol";
import { CheckIcon } from "@phosphor-icons/react";
import { appName, chooserFailure, chooserWaitingCopy } from "@ace/ui-core/computer-use";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useHostIdentity } from "@/lib/host-name.ts";
import { ScreenClientError } from "./screen-session.ts";
import { describeProblem, type ComputerUse } from "./use-computer-use.ts";

/** The sharing-dialog session still waiting for the person at the machine, if any. */
function waitingChoice(use: ComputerUse): string | undefined {
  return use.snapshot.states.find(
    (state) => state.target.kind === "chooser" && state.lifecycle === "starting",
  )?.sessionId;
}

export function SharePicker(props: { use: ComputerUse; threadId: string }) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<ScreenInventory>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [target, setTarget] = useState<ScreenTarget>();
  const [busy, setBusy] = useState(false);
  /** A sharing-dialog start is waiting for the person at the machine to choose. */
  const [choosing, setChoosing] = useState(false);
  const agentId = useThreadMeta(props.threadId)?.rootAgentId;
  const machine = useHostIdentity()?.displayName;
  const toast = useToast();
  const session = props.use.session;
  /** Whether this machine's own sharing dialog picks what is shared, from its last listing. */
  const [dialogPicks, setDialogPicks] = useState(false);
  const chooser = inventory
    ? inventory.chooser
    : dialogPicks
      ? { windows: true, displays: true }
      : undefined;
  const enabled = props.use.snapshot.enabled === true;
  // Learn it before the person opens the picker, so the button names what it does.
  useEffect(() => {
    if (!session || !enabled) return;
    let active = true;
    void session.request({ op: "targets" }).then(
      (raw) => {
        const parsed = ScreenInventory.safeParse(raw);
        if (active && parsed.success) setDialogPicks(!!parsed.data.chooser);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [session, enabled]);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  /** The person cancelled the wait here: its ending needs no sentence. */
  const cancelled = useRef(false);
  useEffect(() => {
    if (!open || !session || attempt < 1) return;
    let active = true;
    void session
      .request({ op: "targets" })
      .then((raw) => {
        if (!active) return;
        const parsed = ScreenInventory.parse(raw);
        setInventory(parsed);
        setDialogPicks(!!parsed.chooser);
      })
      .catch((cause: unknown) => {
        if (active) {
          const problem = describeProblem(cause);
          setError(`${problem.title}. ${problem.hint ?? "Try again."}`);
        }
      });
    return () => {
      active = false;
    };
  }, [open, session, attempt]);
  const share = async (chosen: ScreenTarget | undefined) => {
    if (!session || !agentId || !chosen || chosen.kind === "display") return;
    setBusy(true);
    setChoosing(chosen.kind === "chooser");
    cancelled.current = false;
    setError("");
    let started: string | undefined;
    try {
      const state = await session.request({
        op: "start",
        target: chosen,
        fps: 10,
        threadId: props.threadId,
      });
      const parsed = ScreenState.parse(state);
      started = parsed.sessionId;
      await session.request({
        op: "controller",
        sessionId: started,
        controller: "agent",
        threadId: props.threadId,
        agentId,
      });
      setOpen(false);
    } catch (cause) {
      if (started) await session.request({ op: "stop", sessionId: started }).catch(() => {});
      if (cancelled.current) return;
      const problem = describeProblem(cause);
      const sentence =
        chosen.kind === "chooser" && cause instanceof ScreenClientError
          ? chooserFailure(cause.errorCode, cause.message)
          : `${problem.title}. ${problem.hint ?? "Try again."}`;
      setError(sentence);
      // The person closed this while the machine's dialog waited: say how it ended anyway.
      if (!openRef.current) toast.error({ title: "Couldn't share", description: sentence });
    } finally {
      setBusy(false);
      setChoosing(false);
    }
  };
  /** Cancel a sharing-dialog wait: stopping the starting session closes the dialog there. */
  const cancelChoice = () => {
    const waiting = waitingChoice(props.use);
    cancelled.current = true;
    if (waiting) void props.use.stop(waiting);
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={!props.use.snapshot.enabled || !agentId}
        onClick={() => {
          setTarget(undefined);
          setInventory(undefined);
          setError("");
          setAttempt((value) => value + 1);
          setOpen(true);
        }}
      >
        {chooser ? "Share a window or screen…" : "Share an app or window…"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (!busy || choosing) && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {chooser ? "Share a window or screen" : "Share an app or window"}
            </DialogTitle>
            <DialogDescription>
              Share with this thread's agent only. You can take it back at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-auto py-2">
            {!inventory && !chooser && !error && <Spinner label="Finding windows" />}
            {choosing && (
              <p role="status" className="text-sm text-muted-foreground">
                {chooserWaitingCopy(machine)}.
              </p>
            )}
            {chooser && !choosing && !error && (
              <p className="text-sm text-muted-foreground">
                {machine || "That computer"} asks in its own sharing dialog which window or screen
                to share. A screen can be watched, not controlled.
              </p>
            )}
            {inventory && !chooser && (
              <div role="group" aria-label="Apps and windows">
                {[...new Set(inventory.windows.map((window) => window.bundleId))].map(
                  (bundleId) => (
                    <Button
                      key={bundleId}
                      variant="ghost"
                      size="sm"
                      className="h-8 w-full justify-start"
                      aria-pressed={target?.kind === "app" && target.bundleId === bundleId}
                      onClick={() => setTarget({ kind: "app", bundleId })}
                    >
                      {appName(bundleId)}
                      {target?.kind === "app" && target.bundleId === bundleId && (
                        <CheckIcon aria-hidden size={14} />
                      )}
                    </Button>
                  ),
                )}
                {inventory.windows.map((window) => (
                  <Button
                    key={window.windowId}
                    variant="ghost"
                    size="sm"
                    className="h-8 w-full justify-start truncate"
                    aria-pressed={target?.kind === "window" && target.windowId === window.windowId}
                    onClick={() =>
                      setTarget({
                        kind: "window",
                        bundleId: window.bundleId,
                        windowId: window.windowId,
                      })
                    }
                  >
                    {appName(window.bundleId)} · {window.title || "Untitled window"}
                    {target?.kind === "window" && target.windowId === window.windowId && (
                      <CheckIcon aria-hidden size={14} />
                    )}
                  </Button>
                ))}
                {!inventory.windows.length && (
                  <p className="text-sm text-muted-foreground">
                    No windows found. Open the app you want to share, then refresh.
                  </p>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-status-failed">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            {choosing ? (
              <Button variant="ghost" onClick={cancelChoice}>
                Cancel
              </Button>
            ) : chooser ? (
              <Button disabled={busy} onClick={() => void share({ kind: "chooser" })}>
                {error ? "Try again" : "Open the sharing dialog"}
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setInventory(undefined);
                    setError("");
                    setAttempt((value) => value + 1);
                  }}
                >
                  Refresh
                </Button>
                <Button disabled={busy || !target} onClick={() => void share(target)}>
                  {busy ? "Sharing…" : "Share with agent"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
