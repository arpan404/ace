import type { ReactNode } from "react";
import { Screen } from "@/features/shell/screen.tsx";

/** One settings page: header "Settings  <page>", 48px body, 20px title, optional lede. */
export function SettingsBody(props: {
  page: string;
  lede?: ReactNode;
  actions?: ReactNode;
  /** A quiet link above the title, e.g. "‹ Advanced" on the Theme editor. */
  back?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Screen title="Settings" subtitle={props.page} actions={props.actions}>
      <div className="h-full overflow-auto px-12 pt-10 pb-20">
        {props.back}
        <h2 className="text-xl font-semibold tracking-title">{props.page}</h2>
        {props.lede && (
          <p className="mt-1 max-w-[62ch] text-base leading-normal text-muted-foreground">
            {props.lede}
          </p>
        )}
        {props.children}
      </div>
    </Screen>
  );
}
