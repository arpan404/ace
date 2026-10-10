import { useProviderEntries, entryStatus } from "./provider-entries.ts";
import { RunChecks } from "@/features/diagnostics/index.ts";
import { SupportExport } from "@/features/diagnostics/index.ts";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useConnectionState } from "@ace/client-react";
import { useSettingsBackend } from "./data/use-settings.ts";
import { DaemonHealth } from "./daemon-health.tsx";
import { DaemonSettings } from "./daemon-settings.tsx";
import { DisabledReason, offlineReason } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

/** Daemon diagnostics and a full reset. Thresholds live on General; the theme editor under Appearance. */
export function AdvancedSettings() {
  const { entries } = useProviderEntries();
  const providers = (entries ?? []).map((entry) => {
    const status = entryStatus(entry);
    return {
      id: entry.id,
      name: entry.install.name,
      tone: status.tone,
      text: status.text,
      ready: entry.view?.ready ?? status.tone === "ready",
    };
  });
  return (
    <>
      <SettingSection label="Health">
        <RunChecks providers={providers} />
        <SupportExport />
        <DaemonDiagnostics />
      </SettingSection>
      <SettingSection label="Reset" scope="daemon">
        <SettingRow
          {...settingRow("advanced.reset")}
          description="Settings go back to their defaults on every device. Appearance, themes and this computer's notifications stay."
          inline
        >
          <ResetAll />
        </SettingRow>
      </SettingSection>
      {/* The in-page development daemon: a developer detail, so not on General. */}
      <DaemonSettings />
    </>
  );
}

/**
 * Reset all: the dialog stays open while it runs ("Resetting…"); a failure shows inside it,
 * success closes it with a toast.
 */
function ResetAll() {
  const backend = useSettingsBackend();
  const toast = useToast();
  const offline = useConnectionState() !== "ready";
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const reset = async () => {
    setRunning(true);
    setError(undefined);
    try {
      await backend.reset();
      setOpen(false);
      toast.add({ title: "Settings reset" });
    } catch {
      const message = "This computer couldn't save the reset. Try again.";
      setError(message);
      toast.error({
        title: "Couldn't reset settings",
        description: message,
        actionProps: { children: "Try again", onClick: () => void reset() },
      });
    } finally {
      setRunning(false);
    }
  };
  const trigger = (
    <Button size="sm" variant="danger" disabled={offline} onClick={() => setOpen(true)}>
      Reset
    </Button>
  );
  return (
    <Dialog open={open} onOpenChange={(next) => !running && setOpen(next)}>
      <DisabledReason reason={offline ? offlineReason : undefined}>{trigger}</DisabledReason>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset all settings?</DialogTitle>
          <DialogDescription>
            Defaults for new threads, shortcuts and thresholds are restored for every device using
            this computer. Appearance, themes and this computer's notifications stay.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            Couldn't reset: {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={running} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={running} onClick={() => void reset()}>
            {running ? "Resetting…" : "Reset settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Memory, sessions and queue depths: for debugging the daemon, so folded away until asked for. */
function DaemonDiagnostics() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingRow
        {...settingRow("advanced.diagnostics")}
        description="Memory, sessions and queue depths, refreshed every 15 seconds while shown."
        inline
      >
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
      </SettingRow>
      {open && (
        <div className="fx-rise-in py-4">
          <DaemonHealth />
        </div>
      )}
    </>
  );
}
