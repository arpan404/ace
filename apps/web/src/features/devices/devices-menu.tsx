import {
  AppWindowIcon,
  DotsThreeIcon,
  GlobeIcon,
  MapPinIcon,
  MoonIcon,
  PackageIcon,
  PlayIcon,
  PowerIcon,
  GearSixIcon,
  StopIcon,
  TranslateIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { DeviceActionDialog, type DeviceAction } from "./device-action-dialog.tsx";
import type { useDevices } from "./use-devices.ts";

const icon = (Glyph: typeof PackageIcon) => <Glyph aria-hidden size={16} />;

/**
 * The device's ⋯: install and open apps, appearance, location and language, the live view, booting and shutting down, and Settings › Simulators, where devices
 * are turned on and off for the whole machine.
 */
export function DevicesMenu(props: { devices: ReturnType<typeof useDevices> }) {
  const { devices } = props;
  const { view } = devices;
  const controls = view.selected ? view.controls : undefined;
  const [action, setAction] = useState<DeviceAction>();
  const [appearance, setAppearance] = useState<"light" | "dark">();
  const navigate = useNavigate();
  const unavailable = view.pending || !controls?.running;
  const item = (name: DeviceAction, glyph: typeof PackageIcon) => (
    <MenuItem icon={icon(glyph)} disabled={unavailable} onClick={() => setAction(name)}>
      {name}
    </MenuItem>
  );
  return (
    <>
      <Menu>
        <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="Device actions" />} />
        <MenuContent align="end">
          {controls && (
            <>
              {item("Install app…", PackageIcon)}
              {item("Open app…", AppWindowIcon)}
              {item("Open URL…", GlobeIcon)}
              <MenuSub>
                <MenuSubTrigger icon={icon(MoonIcon)} disabled={unavailable}>
                  Appearance
                </MenuSubTrigger>
                <MenuContent aria-label="Appearance" side="right" align="start" sideOffset={4}>
                  <MenuRadioGroup
                    value={appearance ?? ""}
                    onValueChange={(value: string) => {
                      if (value !== "light" && value !== "dark") return;
                      setAppearance(value);
                      devices.configure({ appearance: value });
                    }}
                  >
                    <MenuRadioItem value="light" closeOnClick>
                      Light
                    </MenuRadioItem>
                    <MenuRadioItem value="dark" closeOnClick>
                      Dark
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuContent>
              </MenuSub>
              {item("Location…", MapPinIcon)}
              {item("Language and region…", TranslateIcon)}
              <MenuSeparator />
              {(controls.cleanupRequired || (controls.running && controls.live)) && (
                <MenuItem icon={icon(StopIcon)} disabled={view.pending} onClick={devices.stop}>
                  {controls.cleanupRequired ? "Retry cleanup" : "Stop live view"}
                </MenuItem>
              )}
              {controls.running && !controls.live && !controls.cleanupRequired && (
                <MenuItem
                  icon={icon(PlayIcon)}
                  disabled={view.pending || controls.busy}
                  onClick={devices.start}
                >
                  Start live view
                </MenuItem>
              )}
              {controls.running ? (
                <MenuItem icon={icon(PowerIcon)} disabled={view.pending} onClick={devices.shutdown}>
                  Shut down
                </MenuItem>
              ) : (
                <MenuItem
                  icon={icon(PowerIcon)}
                  disabled={view.pending || controls.busy}
                  onClick={devices.boot}
                >
                  Boot
                </MenuItem>
              )}
              <MenuSeparator />
            </>
          )}
          <MenuItem
            icon={icon(GearSixIcon)}
            onClick={() => void navigate({ to: "/settings/simulators" })}
          >
            Settings
          </MenuItem>
        </MenuContent>
      </Menu>
      {action && (
        <DeviceActionDialog action={action} devices={devices} close={() => setAction(undefined)} />
      )}
    </>
  );
}
