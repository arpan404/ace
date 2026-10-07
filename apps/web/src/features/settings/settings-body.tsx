import type { ReactNode } from "react";
import { Screen } from "@/features/shell/index.ts";

/**
 * One settings page: the header says "Settings"; the page title (22/600) and its lede head a
 * centred 760px column, so every control sits within reach of its label.
 */
export function SettingsBody(props: {
  page: string;
  lede?: ReactNode;
  actions?: ReactNode;
  /** A quiet link above the title, e.g. "‹ Appearance" on the Theme editor. */
  back?: ReactNode;
  /** A mark beside the title (a provider's page). */
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Screen title="Settings" actions={props.actions}>
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          {props.back}
          <div className="flex items-center gap-4">
            {props.icon}
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-semibold tracking-title">{props.page}</h2>
              {props.lede && (
                <div className="mt-1 max-w-[62ch] text-base leading-normal text-muted-foreground">
                  {props.lede}
                </div>
              )}
            </div>
          </div>
          {props.children}
        </div>
      </div>
    </Screen>
  );
}
