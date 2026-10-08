import { DotsThreeIcon, PlayIcon, PowerIcon, ProhibitIcon, StopIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { DeviceActionDialog, type DeviceAction } from "./device-action-dialog.tsx";
import type { useDevices } from "./use-devices.ts";

/**
 * The ⋯ beside the device: the live view, booting and shutting down, and turning devices off.
 * Disabling is machine-wide while the panel is per thread, so it asks first.
 */
export function DevicesMenu(props: { devices: ReturnType<typeof useDevices> }) {
  const { devices } = props;
  const { view } = devices;
  const controls = view.selected ? view.controls : undefined;
  const [action, setAction] = useState<DeviceAction>();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<IconButton icon={DotsThreeIcon} label="Device actions" size="sm" />}
        />
        <MenuContent align="end">
          {controls && (
            <>
              {(
                [
                  "Install app…",
                  "Open URL…",
                  "Open app…",
                  "Device settings…",
                ] satisfies DeviceAction[]
              ).map((name) => (
                <MenuItem
                  key={name}
                  disabled={view.pending || !controls.running}
                  onClick={() => setAction(name)}
                >
                  {name}
                </MenuItem>
              ))}
              <MenuItem disabled={view.pending || !controls.live} onClick={devices.screenshot}>
                Screenshot
              </MenuItem>
              <MenuItem
                disabled={view.pending || !controls.live || !controls.approvedHere}
                onClick={devices.record}
              >
                {devices.recording ? "Stop recording" : "Record"}
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          {controls?.running && controls.live && (
            <MenuItem
              icon={<StopIcon aria-hidden size={16} />}
              disabled={view.pending}
              onClick={devices.stop}
            >
              Stop live view
            </MenuItem>
          )}
          {controls?.running && !controls.live && (
            <MenuItem
              icon={<PlayIcon aria-hidden size={16} />}
              disabled={view.pending || controls.busy}
              onClick={devices.start}
            >
              Start live view
            </MenuItem>
          )}
          {controls &&
            (controls.running ? (
              <MenuItem
                icon={<PowerIcon aria-hidden size={16} />}
                disabled={view.pending}
                onClick={devices.shutdown}
              >
                Shut down
              </MenuItem>
            ) : (
              <MenuItem
                icon={<PowerIcon aria-hidden size={16} />}
                disabled={view.pending}
                onClick={devices.boot}
              >
                Boot
              </MenuItem>
            ))}
          {controls && <MenuSeparator />}
          <MenuItem
            icon={<ProhibitIcon aria-hidden size={16} />}
            disabled={view.pending}
            onClick={() => setConfirm(true)}
          >
            Disable devices…
          </MenuItem>
        </MenuContent>
      </Menu>
      {action && (
        <DeviceActionDialog action={action} devices={devices} close={() => setAction(undefined)} />
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable devices on this machine?</DialogTitle>
            <DialogDescription>
              This turns devices off for every thread, not just this one. Agents lose the devices
              you approved, and live views stop.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirm(false);
                devices.enable(false);
              }}
            >
              Disable devices
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
