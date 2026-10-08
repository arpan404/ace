import { useThreadMeta } from "@ace/client-react";
import { ScreenInventory, ScreenState, type ScreenTarget } from "@ace/protocol";
import { CheckIcon } from "@phosphor-icons/react";
import { appName, alwaysAsks } from "@ace/ui-core/computer-use";
import { useEffect, useState } from "react";
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
import { describeProblem, type ComputerUse } from "./use-computer-use.ts";

export function SharePicker(props: { use: ComputerUse; threadId: string }) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<ScreenInventory>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [target, setTarget] = useState<ScreenTarget>();
  const [busy, setBusy] = useState(false);
  const agentId = useThreadMeta(props.threadId)?.rootAgentId;
  const session = props.use.session;
  useEffect(() => {
    if (!open || !session || attempt < 1) return;
    let active = true;
    void session
      .request({ op: "targets" })
      .then((raw) => {
        if (active) setInventory(ScreenInventory.parse(raw));
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
  const share = async () => {
    if (!session || !agentId || !target || target.kind === "display") return;
    setBusy(true);
    setError("");
    let started: string | undefined;
    try {
      await session.request({
        op: "approve",
        bundleId: target.bundleId,
        allowed: true,
        scope: alwaysAsks(target.bundleId) ? "turn" : "thread",
        threadId: props.threadId,
      });
      const state = await session.request({
        op: "start",
        target,
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
      const problem = describeProblem(cause);
      setError(`${problem.title}. ${problem.hint ?? "Try again."}`);
    } finally {
      setBusy(false);
    }
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
        Share an app or window…
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share an app or window</DialogTitle>
            <DialogDescription>
              Share with this thread's agent only. Sensitive apps ask again each turn. You can
              revoke access at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-auto py-2">
            {!inventory && !error && <Spinner label="Finding windows" />}
            {inventory && (
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
            <Button disabled={busy || !target} onClick={() => void share()}>
              {busy ? "Sharing…" : "Share with agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
