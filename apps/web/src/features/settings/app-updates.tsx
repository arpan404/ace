import { useState } from "react";
import { openRelease, useDesktopUpdate } from "@/boot/desktop-updates.ts";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
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
