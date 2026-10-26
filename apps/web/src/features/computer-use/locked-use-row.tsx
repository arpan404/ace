import { useId } from "react";
import { SettingNote, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { lockedUseLabel, lockedUseShown, lockedUseSwitchOn } from "./locked-use-reading.ts";
import type { ComputerUse } from "./use-computer-use.ts";
import { useLockedUse } from "./use-locked-use.ts";

/** The Electron host says its platform; a plain browser falls back to its user agent. */
function hostIsMac(): boolean {
  const platform = document.documentElement.dataset.platform;
  if (platform) return platform === "darwin";
  return /Mac/.test(navigator.userAgent);
}

/**
 * Let agents work while this Mac is locked: the Mac's actual state in words, a switch that
 * installs or removes the component, and Repair when what's installed has drifted. Only on a
 * Mac with the screen helper; elsewhere the page leaves it out.
 */
export function LockedUseRow(props: { use: ComputerUse }) {
  const locked = useLockedUse();
  const id = useId();
  const { status } = locked;
  if (
    !lockedUseShown({
      screenUnavailable: props.use.snapshot.unavailable,
      status,
      hostIsMac: hostIsMac(),
    }) ||
    !status
  )
    return null;
  const { label, tone } = lockedUseLabel(status);
  const disabled = !locked.connected || locked.pending || status.state === "installing";
  const recheck = (
    <button
      type="button"
      className="text-link focus-ring rounded-xs hover:underline disabled:opacity-40"
      disabled={!locked.connected || locked.pending}
      onClick={locked.recheck}
    >
      Check again
    </button>
  );
  return (
    <>
      <SettingRow
        title="Let agents work while this Mac is locked"
        description="Installs a macOS component, which asks for an administrator's approval; agents work behind the lock screen and you can take over any time."
        htmlFor={id}
        inline
      >
        <StatusLabel tone={tone} label={label} />
        {status.state === "driftRepairNeeded" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => void locked.repair()}
          >
            Repair
          </Button>
        )}
        <Switch
          id={id}
          checked={lockedUseSwitchOn(status)}
          disabled={disabled}
          onCheckedChange={(checked) => void (checked ? locked.install() : locked.remove())}
        />
      </SettingRow>
      {status.state === "installFailed" || status.state === "driftRepairNeeded" ? (
        <SettingNote role="status">
          <span className="font-medium text-foreground">{status.reason}</span> {recheck}
        </SettingNote>
      ) : status.state === "needsApproval" ? (
        <SettingNote>Approved it in System Settings? {recheck}</SettingNote>
      ) : null}
    </>
  );
}
