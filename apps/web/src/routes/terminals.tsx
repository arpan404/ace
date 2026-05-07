import { ThreadId, type TerminalProcessSummary } from "@ace/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { AppPageTopBar } from "../components/AppPageTopBar";
import { HEADER_PILL_CONTROL_CLASS_NAME, TopBarCluster } from "../components/thread/TopBarCluster";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { reportBackgroundError } from "../lib/async";
import { buildSingleThreadRouteSearch } from "../lib/chatThreadBoardRouteSearch";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";

type TerminalProcessLoadState = "idle" | "loading" | "ready" | "error";

function terminalTitle(process: TerminalProcessSummary): string {
  return process.title?.trim() || process.terminalId;
}

function terminalStateLabel(process: TerminalProcessSummary): string {
  if (process.hasRunningSubprocess) {
    return "busy";
  }
  return process.status;
}

function formatPid(pid: number | null): string {
  return pid === null ? "-" : String(pid);
}

function formatShortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

function formatCwd(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return cwd;
  }
  return `.../${segments.slice(-2).join("/")}`;
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "just now";
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function sortTerminalProcesses(
  processes: ReadonlyArray<TerminalProcessSummary>,
): TerminalProcessSummary[] {
  return [...processes].toSorted((left, right) => {
    const statusCompare =
      Number(right.status === "running") - Number(left.status === "running") ||
      Number(right.hasRunningSubprocess) - Number(left.hasRunningSubprocess);
    if (statusCompare !== 0) {
      return statusCompare;
    }
    const updatedCompare = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(updatedCompare) && updatedCompare !== 0) {
      return updatedCompare;
    }
    const threadCompare = left.threadId.localeCompare(right.threadId);
    if (threadCompare !== 0) {
      return threadCompare;
    }
    return left.terminalId.localeCompare(right.terminalId);
  });
}

function TerminalsPage() {
  const navigate = useNavigate();
  const [processes, setProcesses] = useState<ReadonlyArray<TerminalProcessSummary>>([]);
  const [loadState, setLoadState] = useState<TerminalProcessLoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const sortedProcesses = useMemo(() => sortTerminalProcesses(processes), [processes]);
  const runningCount = sortedProcesses.filter((process) => process.status === "running").length;

  const openThread = useCallback(
    (threadId: string) => {
      void navigate({
        to: "/$threadId",
        params: { threadId: ThreadId.makeUnsafe(threadId) },
        search: buildSingleThreadRouteSearch(),
      });
    },
    [navigate],
  );

  const handleThreadRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, threadId: string) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      openThread(threadId);
    },
    [openThread],
  );

  const refreshProcesses = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      setLoadState("error");
      setErrorMessage("Terminal process management is unavailable.");
      return;
    }
    setLoadState((current) => (current === "ready" ? current : "loading"));
    setErrorMessage(null);
    try {
      const nextProcesses = await api.terminal.list({ runningOnly: true });
      setProcesses(nextProcesses);
      setLoadState("ready");
    } catch (error) {
      setLoadState("error");
      setErrorMessage(error instanceof Error ? error.message : "Failed to load terminals.");
    }
  }, []);

  const stopProcess = useCallback(
    async (process: TerminalProcessSummary) => {
      const api = readNativeApi();
      if (!api) return;
      const id = `${process.threadId}:${process.terminalId}`;
      setStoppingId(id);
      try {
        await api.terminal.terminate({
          threadId: process.threadId,
          terminalId: process.terminalId,
        });
        await refreshProcesses();
      } catch (error) {
        reportBackgroundError("Failed to stop terminal process.", error);
        setErrorMessage(error instanceof Error ? error.message : "Failed to stop terminal.");
      } finally {
        setStoppingId(null);
      }
    },
    [refreshProcesses],
  );

  useEffect(() => {
    void refreshProcesses();
  }, [refreshProcesses]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.terminal.onEvent((event) => {
      if (
        event.type === "started" ||
        event.type === "restarted" ||
        event.type === "exited" ||
        event.type === "activity"
      ) {
        void refreshProcesses();
      }
    });
  }, [refreshProcesses]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <AppPageTopBar>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <h1 className="min-w-0 shrink truncate text-[13px] leading-none font-semibold tracking-tight text-foreground">
                Terminals
              </h1>
              <span className="h-3.5 w-px shrink-0 bg-border/70" aria-hidden="true" />
              <span className="min-w-0 truncate text-[12px] leading-none font-medium text-muted-foreground/72">
                {runningCount} running
              </span>
            </div>
            <TopBarCluster className="shrink-0">
              <Button
                size="default"
                variant="ghost"
                onClick={() => void refreshProcesses()}
                disabled={loadState === "loading"}
                className={HEADER_PILL_CONTROL_CLASS_NAME}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", loadState === "loading" && "animate-spin")}
                />
                Refresh
              </Button>
            </TopBarCluster>
          </div>
        </AppPageTopBar>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <section className="mx-auto w-full max-w-4xl px-3 py-3 sm:px-4">
            <div className="min-w-0">
              <div className="flex h-8 items-center justify-between gap-3 px-0.5">
                <h2 className="truncate text-[11px] font-semibold tracking-[0.16em] text-muted-foreground/80 uppercase">
                  Running terminals
                </h2>
                {loadState === "error" && errorMessage ? (
                  <span className="truncate text-[12px] text-destructive">{errorMessage}</span>
                ) : null}
              </div>

              {loadState === "loading" && sortedProcesses.length === 0 ? (
                <div className="border-t border-border/35 px-0.5 py-6 text-[13px] text-muted-foreground">
                  Loading terminals...
                </div>
              ) : null}

              {loadState !== "loading" && sortedProcesses.length === 0 ? (
                <div className="border-t border-border/35 px-0.5 py-6">
                  <p className="text-[13px] font-medium text-foreground">No terminals running</p>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    Terminal processes started from threads will appear here.
                  </p>
                </div>
              ) : null}

              {sortedProcesses.length > 0 ? (
                <div className="min-w-0 border-y border-border/35">
                  {sortedProcesses.map((process) => {
                    const id = `${process.threadId}:${process.terminalId}`;
                    const stopping = stoppingId === id;
                    return (
                      <div
                        key={id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openThread(process.threadId)}
                        onKeyDown={(event) => handleThreadRowKeyDown(event, process.threadId)}
                        className="group/terminal grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/28 px-0.5 py-2.25 transition-colors last:border-b-0 hover:bg-muted/22 focus-visible:bg-muted/24 focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:outline-none sm:px-1"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              process.hasRunningSubprocess ? "bg-amber-500" : "bg-emerald-500",
                            )}
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[13px] font-medium text-foreground">
                                {terminalTitle(process)}
                              </span>
                              <span className="shrink-0 text-[11px] text-muted-foreground/68">
                                {terminalStateLabel(process)}
                              </span>
                            </div>
                            <div className="mt-0.75 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground/72">
                              <span className="min-w-0 max-w-[28rem] truncate">
                                {formatCwd(process.cwd)}
                              </span>
                              <span className="text-muted-foreground/40">·</span>
                              <span>pid {formatPid(process.pid)}</span>
                              <span className="text-muted-foreground/40">·</span>
                              <span>thread {formatShortId(process.threadId)}</span>
                              <span className="text-muted-foreground/40">·</span>
                              <span>{formatUpdatedAt(process.updatedAt)}</span>
                            </div>
                          </div>
                        </div>

                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={stopping || process.status !== "running"}
                          onClick={(event) => {
                            event.stopPropagation();
                            void stopProcess(process);
                          }}
                          className="h-7 rounded-[var(--control-radius)] px-2 text-[12px] font-medium text-muted-foreground opacity-72 transition-opacity hover:bg-destructive/8 hover:text-destructive group-hover/terminal:opacity-100"
                        >
                          <SquareIcon className="size-3" aria-hidden="true" />
                          {stopping ? "Stopping" : "Stop"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </section>
        </main>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/terminals")({
  component: TerminalsPage,
});
