import { CaretDownIcon, DesktopTowerIcon, DeviceMobileIcon } from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import { createContext, use, useMemo, useRef, useState, type ReactNode } from "react";
import { useHashFlash } from "@/components/setting-row.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { AddMachine } from "./add-machine.tsx";
import { fleetWarning } from "./data/fleet-words.ts";
import { settingKeys } from "./data/setting-keys.ts";
import { useRemoteStatus, useSettingControl } from "./data/use-settings.ts";
import { FleetTabs } from "./fleet-tabs.tsx";
import { PairDeviceDialog } from "./pair-device.tsx";
import { SettingsBody } from "./settings-body.tsx";

type Adding = "machine" | "device" | "code";

/** Opens Fleet's add dialogs from inside a view (a fleet of one's next steps). */
const FleetAddContext = createContext<{ addMachine(): void; pairDevice(): void } | undefined>(
  undefined,
);

export function useFleetAdd() {
  return use(FleetAddContext);
}

/**
 * Fleet's frame, the same on Overview and Map so switching views only changes what's under the
 * tabs: one column width, the title, a warning line only when this computer is hard to reach,
 * one Add menu and the tabs. `/pair` lands here with #pair and opens the pairing code.
 */
export function FleetFrame(props: { onAdded?(hostId: string): void; children: ReactNode }) {
  const hash = useLocation({ select: (location) => location.hash });
  const [adding, setAdding] = useState<Adding | undefined>(hash === "pair" ? "code" : undefined);
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const networks = useRemoteStatus().data?.networks;
  const warning = fleetWarning({
    enabled: enabled.loaded ? enabled.value : true,
    networks: enabled.loaded ? networks : undefined,
  });
  const add = useMemo(
    () => ({ addMachine: () => setAdding("machine"), pairDevice: () => setAdding("device") }),
    [],
  );
  const close = () => setAdding(undefined);
  return (
    <SettingsBody
      page="Fleet"
      wide
      tabs={<FleetTabs />}
      lede={warning}
      titleActions={<AddMenu onPick={setAdding} />}
    >
      <FleetAddContext value={add}>{props.children}</FleetAddContext>
      {adding === "machine" && (
        <AddMachine onClose={close} {...(props.onAdded ? { onAdded: props.onAdded } : {})} />
      )}
      {(adding === "device" || adding === "code") && (
        <PairDeviceDialog code={adding === "code"} onClose={close} />
      )}
    </SettingsBody>
  );
}

/** One Add button: a computer that runs agents, or a device that follows them. */
function AddMenu(props: { onPick(adding: Adding): void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  // Settings search lands on `#remote.pair`: the button flashes like a row would.
  const flashing = useHashFlash("remote.pair", trigger);
  return (
    <Menu>
      <MenuTrigger
        ref={trigger}
        id="remote.pair"
        data-flash={flashing || undefined}
        className={cn(buttonVariants({ size: "sm", variant: "primary" }), "gap-1")}
      >
        Add
        <CaretDownIcon aria-hidden size={12} />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem
          icon={<DesktopTowerIcon aria-hidden size={14} />}
          reason="Runs agents. Sign in there or pair it."
          onClick={() => props.onPick("machine")}
        >
          A computer
        </MenuItem>
        <MenuItem
          icon={<DeviceMobileIcon aria-hidden size={14} />}
          reason="Follows threads and steers agents."
          onClick={() => props.onPick("device")}
        >
          A phone, tablet or browser
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
