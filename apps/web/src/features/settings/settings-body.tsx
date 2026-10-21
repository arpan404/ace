import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useSettingsMachine } from "./machine-scope.tsx";
import { settingsPageOf } from "./settings-pages.ts";

/**
 * One settings page: the header says "Settings"; the page title (22/600) and its lede head a
 * centred column that grows with the window (`--settings-column`), so cards fill the space they
 * have and every control stays within reach of its label. A Machine page names the machine it
 * edits beside the title when there is more than one (`SettingsOutlet` points it there).
 */
export function SettingsBody(props: {
  page: string;
  lede?: ReactNode;
  actions?: ReactNode;
  titleActions?: ReactNode;
  /** A quiet link above the title, e.g. "‹ Appearance" on the Theme editor. */
  back?: ReactNode;
  /** A mark beside the title (a provider's page). */
  icon?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const machinePage = settingsPageOf(pathname)?.group === "machine";
  return (
    <Screen title="Settings" actions={props.actions}>
      <div className="h-full overflow-auto">
        <div className="@container mx-auto w-full max-w-(--settings-column) px-4 pt-6 pb-20 sm:px-8 sm:pt-10">
          {props.back}
          <div className="flex items-center gap-4">
            {props.icon}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-2xl font-semibold tracking-title">{props.page}</h2>
                {machinePage && <EditedMachine />}
              </div>
              {props.lede && (
                <div className="mt-1 max-w-[62ch] text-base leading-normal text-muted-foreground">
                  {props.lede}
                </div>
              )}
            </div>
            {props.trailing}
            {props.titleActions && (
              <div className="shrink-0 self-start pt-1">{props.titleActions}</div>
            )}
          </div>
          {props.children}
        </div>
      </div>
    </Screen>
  );
}

/** Which machine this page edits, once there is more than one to choose from. */
function EditedMachine() {
  const { machine, machines } = useSettingsMachine();
  if (machines.length < 2 || !machine) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-ui text-muted-foreground">
      <MachineMark icon={machine.icon} primary={machine.primary} />
      {machine.name}
    </span>
  );
}
