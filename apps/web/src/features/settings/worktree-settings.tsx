import { SettingSection } from "@/components/setting-row.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { SettingSwitch } from "./setting-switch.tsx";
import { WorktreeTimeoutRow } from "./worktree-preparation.tsx";

/**
 * Settings › Agents › Worktrees: whether new threads get one, how long preparing it may take, and
 * backing worktrees up to origin. Automatic deletion of settled ones stays on Storage.
 */
export function WorktreeSettings() {
  return (
    <SettingSection label="Worktrees" scope="daemon">
      <SettingSwitch setting={settingKeys.worktree} entry="threads.useWorktree" />
      <WorktreeTimeoutRow />
      <SettingSwitch setting={settingKeys.backupWorktrees} entry="storage.backupWorktrees" />
    </SettingSection>
  );
}
