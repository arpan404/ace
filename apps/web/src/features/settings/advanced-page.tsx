import { SwatchesIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { settingKeys, type LogRetention, type UnresponsiveAfter } from "./data/setting-keys.ts";
import { useSetting, useSettingsBackend } from "./data/use-settings.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { DaemonHealth } from "./daemon-health.tsx";
import { DaemonSettings } from "./daemon-settings.tsx";

const unresponsiveOptions: { value: UnresponsiveAfter; label: string }[] = [
  { value: "2m", label: "2 minutes" },
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
];
const retentionOptions: { value: LogRetention; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "forever", label: "Forever" },
];

/** Theme editor entry, health thresholds, log retention, daemon diagnostics and a full reset. */
export function AdvancedSettings() {
  const [unresponsive, setUnresponsive] = useSetting(settingKeys.unresponsiveAfter);
  const [retention, setRetention] = useSetting(settingKeys.logRetention);
  const fake = useDaemonConnection().mode === "fake";
  return (
    <>
      <section className="mt-7" aria-label="Advanced">
        <SettingRow
          title="Theme editor"
          description="Every colour, glass and shape token, with import, export and contrast checks. Saved themes appear under Appearance."
        >
          <Link to="/settings/theme-editor" className={buttonVariants({ size: "sm" })}>
            <SwatchesIcon aria-hidden size={14} />
            Open theme editor
          </Link>
        </SettingRow>
        <SettingRow
          title="Unresponsive after"
          description="No provider events for this long marks a thread unresponsive."
        >
          <Select
            label="Unresponsive after"
            value={unresponsive}
            options={unresponsiveOptions}
            onValueChange={(value) => void setUnresponsive(value)}
          />
        </SettingRow>
        <DaemonDiagnostics />
        <SettingRow title="Keep event logs">
          <Select
            label="Keep event logs"
            value={retention}
            options={retentionOptions}
            onValueChange={(value) => void setRetention(value)}
          />
        </SettingRow>
        <SettingRow
          title="Reset all settings"
          description="Daemon settings go back to their defaults. Themes and appearance on this device stay."
        >
          <ResetAll />
        </SettingRow>
      </section>
      {/* The in-page development daemon: a developer detail, so not on General. */}
      {fake && <DaemonSettings />}
    </>
  );
}

function ResetAll() {
  const backend = useSettingsBackend();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
        Reset
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset all settings?</DialogTitle>
          <DialogDescription>
            Defaults for new threads, notifications, shortcuts and thresholds are restored on every
            client of this daemon.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              void backend.reset().then(() => toast.add({ title: "Settings reset" }));
              setOpen(false);
            }}
          >
            Reset settings
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
        title="Daemon diagnostics"
        description="Memory, sessions and queue depths, refreshed every 15 seconds while shown."
      >
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
      </SettingRow>
      {open && (
        <div className="fx-rise-in pb-4">
          <DaemonHealth />
        </div>
      )}
    </>
  );
}
