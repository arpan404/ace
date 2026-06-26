import { type ServerProvider, PROVIDER_DISPLAY_NAMES } from "@ace/contracts";
import { CopyIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { readNativeApi } from "~/nativeApi";
import { useConnectionHealth } from "~/lib/reliability/connectionHealth";
import { getWsRpcClient } from "~/wsRpcClient";
import type { Thread } from "~/types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { buildReliabilityDiagnosticsCopy } from "./connectionHealthCopy";

type DiagnosticsFocus = "connection" | "provider" | "thread";

interface ReliabilityDiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ServerProvider | null;
  thread: Thread | null;
  focus?: DiagnosticsFocus;
  turnRunning?: boolean;
  onStopTurn?: (() => void) | null;
}

function formatTime(value: number | string | null | undefined): string {
  if (!value) return "Never";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/35 py-2 text-xs last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground/86">{value ?? "None"}</dd>
    </div>
  );
}

function Section({
  id,
  title,
  children,
  focus,
}: {
  id: DiagnosticsFocus;
  title: string;
  children: ReactNode;
  focus?: DiagnosticsFocus | undefined;
}) {
  return (
    <section
      className={
        focus === id
          ? "rounded-lg border border-warning/45 bg-warning/5 px-3 py-2"
          : "rounded-lg border border-border/55 px-3 py-2"
      }
    >
      <h3 className="text-sm font-medium">{title}</h3>
      <dl className="mt-2">{children}</dl>
    </section>
  );
}

export function ReliabilityDiagnosticsDialog({
  open,
  onOpenChange,
  provider,
  thread,
  focus,
  turnRunning = false,
  onStopTurn = null,
}: ReliabilityDiagnosticsDialogProps) {
  const connection = useConnectionHealth();
  const [refreshing, setRefreshing] = useState(false);
  const copyText = buildReliabilityDiagnosticsCopy({ connection, provider, thread });
  const providerLabel = provider
    ? (PROVIDER_DISPLAY_NAMES[provider.provider] ?? provider.provider)
    : "None";

  const refreshProviders = async () => {
    setRefreshing(true);
    try {
      await readNativeApi()?.server.refreshProviders();
      toastManager.add({
        type: "success",
        title: "Provider status refreshed",
        data: { dismissAfterVisibleMs: 3_000 },
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Provider refresh failed",
        description: error instanceof Error ? error.message : "Unable to refresh provider status.",
      });
      setRefreshing(false);
      return;
    }
    setRefreshing(false);
  };

  const copyDiagnostics = async () => {
    await navigator.clipboard?.writeText(copyText);
    toastManager.add({
      type: "success",
      title: "Diagnostics copied",
      data: { dismissAfterVisibleMs: 3_000 },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Reliability Diagnostics</DialogTitle>
          <DialogDescription>Connection, provider, and thread recovery details.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Section id="connection" title="Connection" focus={focus}>
            <Field label="Status" value={connection.kind} />
            <Field label="Last error" value={connection.lastError} />
            <Field label="Last connected" value={formatTime(connection.lastConnectedAt)} />
            <Field label="Last disconnected" value={formatTime(connection.lastDisconnectedAt)} />
            <Field label="Reconnect count" value={connection.reconnectCount} />
          </Section>

          <Section id="provider" title="Provider Status" focus={focus}>
            <Field label="Provider" value={providerLabel} />
            <Field label="Instance" value={provider?.providerInstanceId ?? "Default"} />
            <Field label="Status" value={provider?.status ?? "Unknown"} />
            <Field label="Auth status" value={provider?.auth.status ?? "Unknown"} />
            <Field label="Message" value={provider?.message ?? null} />
            <Field label="Last refreshed" value={provider?.checkedAt ?? null} />
          </Section>

          <Section id="thread" title="Active Thread" focus={focus}>
            <Field label="Thread id" value={thread?.id ?? null} />
            <Field label="Session status" value={thread?.session?.status ?? null} />
            <Field label="Session error" value={thread?.session?.lastError ?? null} />
            <Field label="Latest turn state" value={thread?.latestTurn?.state ?? null} />
            <Field label="Turn running" value={turnRunning ? "Yes" : "No"} />
            <Field label="Thread error" value={thread?.error ?? null} />
          </Section>

          <section className="rounded-lg border border-border/55 px-3 py-2">
            <h3 className="text-sm font-medium">Recovery Actions</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => getWsRpcClient().queueProbeNow("diagnostics")}
              >
                <RefreshCwIcon className="size-3" />
                Retry connection
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refreshProviders()}
                disabled={refreshing}
              >
                <RefreshCwIcon className={refreshing ? "size-3 animate-spin" : "size-3"} />
                Refresh providers
              </Button>
              {turnRunning && onStopTurn ? (
                <Button type="button" variant="destructive" size="sm" onClick={onStopTurn}>
                  <SquareIcon className="size-3" />
                  Stop current turn
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyDiagnostics()}
              >
                <CopyIcon className="size-3" />
                Copy diagnostics
              </Button>
            </div>
          </section>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
