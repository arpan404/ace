import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SettingsRow } from "./SettingsPanelPrimitives";
import {
  DEVICE_ACTION_GROUP_CLASS_NAME,
  DEVICE_META_TEXT_CLASS_NAME,
} from "./deviceSettingsComponentClasses";

export function DeviceSubPanel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const rowProps = {
    title,
    ...(typeof description === "string" ? { description } : {}),
    ...(actions
      ? { control: <div className={DEVICE_ACTION_GROUP_CLASS_NAME}>{actions}</div> }
      : {}),
    ...(className ? { controlClassName: className } : {}),
  };

  return (
    <SettingsRow {...rowProps}>
      {typeof description !== "string" && description ? (
        <p className={cn(DEVICE_META_TEXT_CLASS_NAME, "mt-1")}>{description}</p>
      ) : null}
      <div className="min-w-0 pt-3">{children}</div>
    </SettingsRow>
  );
}
