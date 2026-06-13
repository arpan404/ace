import type { ReactNode } from "react";

import { SettingsSection } from "./SettingsPanelPrimitives";
import { DEVICE_ACTION_GROUP_CLASS_NAME } from "./deviceSettingsComponentClasses";

export function DeviceSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsSection
      title={title}
      description={description}
      headerAction={
        actions ? <div className={DEVICE_ACTION_GROUP_CLASS_NAME}>{actions}</div> : null
      }
    >
      {children}
    </SettingsSection>
  );
}
