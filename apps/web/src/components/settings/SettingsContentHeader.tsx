import type { ReactNode } from "react";

import { AppPageTopBar } from "../AppPageTopBar";
import { cn } from "../../lib/utils";
import {
  SETTINGS_HEADER_PAGE_CLASS,
  SETTINGS_HEADER_ROOT_CLASS,
  SETTINGS_HEADER_SEPARATOR_CLASS,
  SETTINGS_PAGE_TITLE_CLASS,
} from "./settingsUi";

export function SettingsContentHeader({
  pageLabel,
  action,
}: {
  pageLabel: ReactNode;
  action?: ReactNode;
}) {
  return (
    <AppPageTopBar>
      <div className="flex min-w-0 w-full flex-1 items-center justify-between gap-4">
        <h1 className={cn(SETTINGS_PAGE_TITLE_CLASS, "min-w-0 [-webkit-app-region:no-drag]")}>
          <span className={SETTINGS_HEADER_ROOT_CLASS}>Settings</span>
          <span className={SETTINGS_HEADER_SEPARATOR_CLASS} aria-hidden="true">
            |
          </span>
          <span className={SETTINGS_HEADER_PAGE_CLASS}>{pageLabel}</span>
        </h1>
        {action ? <div className="shrink-0 [-webkit-app-region:no-drag]">{action}</div> : null}
      </div>
    </AppPageTopBar>
  );
}
