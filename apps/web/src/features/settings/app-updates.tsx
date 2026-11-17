import { useState } from "react";
import {
  openRelease,
  useDesktopUpdate,
  type ReleaseLine,
  type UpdateStatus,
} from "@/boot/desktop-updates.ts";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import {
  UpdateRestartDialog,
  updateAction,
  updateActionWords,
  updateSummary,
} from "@/features/shell/index.ts";
import { settingRow } from "./settings-index.ts";

/**
 * The desktop app's update in Settings: where it stands and the one next step, the same as
 * the sidebar's update button. Nothing in a browser.
 */
export function AppUpdateRow(props: { scope?: object }) {
  const update = useDesktopUpdate(props.scope);
  const [confirming, setConfirming] = useState(false);
  /** Agents the Restart would stop: undefined while counting, null when unknown. */
  const [busy, setBusy] = useState<number | null | undefined>(undefined);
  const status = update.status;
  if (!status) return null;
  const action = updateAction(status);
  const words = updateActionWords(status);
  const act = () => {
    if (action === "check") void update.check();
    else if (action === "download") update.download();
    else if (action === "open-release" && status.releaseUrl)
      openRelease(status.releaseUrl, props.scope);
    else if (action === "install") {
      setConfirming(true);
      setBusy(undefined);
      void update.busy().then((count) => setBusy(count ?? null));
    }
  };
  return (
    <SettingRow {...settingRow("app.updates")} description={updateSummary(status)} inline>
      {words ? (
        <Button size="sm" onClick={act}>
          {words}
        </Button>
      ) : null}
      <UpdateRestartDialog
        open={confirming}
        busy={busy}
        onOpenChange={setConfirming}
        onInstall={() => update.install()}
      />
    </SettingRow>
  );
}

const lines = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
] as const satisfies readonly { value: ReleaseLine; label: string }[];

/** What the line row says: why a switch is held back, or what each line gets. */
export function releaseLineSummary(status: UpdateStatus): string {
  if (status.blocked) return status.blocked;
  return status.line === "beta"
    ? "Beta gets builds of main between stable releases."
    : "Stable gets each release once it's ready.";
}

/**
 * Which release line the app updates from (ADR 0177): Stable or Beta, in the same app. When the
 * line's release can't read this install's data, one sentence says why it isn't offered.
 */
export function ReleaseLineRow(props: { scope?: object }) {
  const update = useDesktopUpdate(props.scope);
  const [pending, setPending] = useState(false);
  const status = update.status;
  if (!status || !update.canSetLine) return null;
  return (
    <SettingRow {...settingRow("app.updateLine")} description={releaseLineSummary(status)} inline>
      <SegmentedControl<ReleaseLine>
        label="Release line"
        size="sm"
        value={status.line}
        options={lines}
        disabled={pending}
        onValueChange={(line) => {
          setPending(true);
          void update.setLine(line).finally(() => setPending(false));
        }}
      />
    </SettingRow>
  );
}
