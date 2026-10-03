import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { keymap } from "@/lib/keymap.ts";

/** Every global shortcut, read from the one keymap the app binds. */
export function KeyboardShortcuts() {
  return (
    <SettingSection label="Shortcuts">
      {Object.entries(keymap).map(([id, binding]) => (
        <SettingRow key={id} title={binding.label}>
          <Kbd keys={binding.keys} className="h-5 px-2 text-[12px]" />
        </SettingRow>
      ))}
    </SettingSection>
  );
}
