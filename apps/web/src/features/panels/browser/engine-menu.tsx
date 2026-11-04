import { GlobeIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import {
  MenuContent,
  MenuGroup,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
} from "@/components/ui/menu.tsx";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { browserEngineLabel } from "./engine-words.ts";

/**
 * The ⋯ menu's "Engine for this thread": moves this thread's browser between the desktop app and
 * ace's Chrome, in the words Settings › Browser uses, and names the default it overrides.
 */
export function EngineMenu(props: {
  engine: "embedded" | "headless" | "user" | undefined;
  online: boolean;
  onEngine(engine: "embedded" | "headless"): void;
}) {
  const [fallback] = useDaemonSetting("browser.backend");
  // The group stays controlled (nothing checked) before the thread has a browser.
  const picked = props.engine === "embedded" || props.engine === "headless" ? props.engine : "";
  const defaultLabel = browserEngineLabel(fallback);
  return (
    <MenuSub>
      <MenuSubTrigger icon={<Icon icon={GlobeIcon} />} disabled={!props.online}>
        Engine for this thread
      </MenuSubTrigger>
      <MenuContent side="inline-start" align="start" sideOffset={4}>
        <MenuRadioGroup
          value={picked}
          onValueChange={(next: unknown) => {
            if (next === "embedded" || next === "headless") props.onEngine(next);
          }}
        >
          <MenuRadioItem value="embedded" disabled={!props.online}>
            {browserEngineLabel("embedded")}
          </MenuRadioItem>
          <MenuRadioItem value="headless" disabled={!props.online}>
            {browserEngineLabel("headless")}
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuGroup>
          <MenuLabel className="max-w-56 whitespace-normal">
            {defaultLabel
              ? `Other threads use ${defaultLabel}, the default in Settings › Browser.`
              : "Other threads use the default in Settings › Browser."}
          </MenuLabel>
        </MenuGroup>
      </MenuContent>
    </MenuSub>
  );
}
