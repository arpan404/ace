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
  children?: ReactNode;
}) {
  return (
    <Screen title="Settings" actions={props.actions}>
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-(--column) px-4 pt-6 pb-20 sm:px-8 sm:pt-11">
          {props.back}
          <h2 className="text-2xl font-semibold tracking-title">{props.page}</h2>
          {props.lede && (
            <p className="mt-1 max-w-[62ch] text-base leading-normal text-muted-foreground">
              {props.lede}
            </p>
          )}
          {props.children}
        </div>
      </div>
    </Screen>
  );
}
