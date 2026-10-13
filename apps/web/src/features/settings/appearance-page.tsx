import { AccentPicker } from "./accent-picker.tsx";
import { ThemeChooser } from "./theme-chooser.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import {
  TranscriptSize,
  transcriptSizes,
  type Density,
  type Mode,
  type ReduceMotion,
  type SurfaceSetting,
} from "@/theme/appearance.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { settingRow } from "./settings-index.ts";

const modeOptions: { value: Mode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];
const surfaceOptions: { value: SurfaceSetting; label: string }[] = [
  { value: "translucent", label: "Translucent" },
  { value: "solid", label: "Solid" },
];
const motionOptions: { value: ReduceMotion; label: string }[] = [
  { value: "system", label: "System" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];
const densityOptions: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];
const sizeOptions = TranscriptSize.options.map((value) => ({
  value,
  label: transcriptSizes[value].label,
}));

/** Mode, theme, surfaces, motion, density and transcript size. Every change applies at once. */
export function AppearanceSettings() {
  const { appearance, update, systemReducesTransparency } = useTheme();
  return (
    <>
      <SettingSection label="Look" card scope="device">
        <SettingRow {...settingRow("appearance.mode")}>
          <SegmentedControl
            label="Mode"
            value={appearance.mode}
            options={modeOptions}
            onValueChange={(mode) => update({ mode })}
          />
        </SettingRow>
        <div data-setting-slot="" id="appearance.theme" className="flex flex-col gap-3 px-4 py-3.5">
          <div className="text-ui font-medium">{settingRow("appearance.theme").title}</div>
          <ThemeChooser />
        </div>
        <SettingRow {...settingRow("appearance.accent")}>
          <AccentPicker />
        </SettingRow>
        <SettingRow
          {...settingRow("appearance.surfaces")}
          description={
            systemReducesTransparency && appearance.surface === "translucent"
              ? "Solid while your system reduces transparency"
              : undefined
          }
        >
          <SegmentedControl
            label="Surfaces"
            value={appearance.surface}
            options={surfaceOptions}
            onValueChange={(surface) => update({ surface })}
          />
        </SettingRow>
        <SettingRow {...settingRow("appearance.reduceMotion")}>
          <SegmentedControl
            label="Reduce motion"
            value={appearance.reduceMotion}
            options={motionOptions}
            onValueChange={(reduceMotion) => update({ reduceMotion })}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection label="Display" card scope="device">
        <SettingRow
          {...settingRow("appearance.density")}
          description="Spacing in settings, lists and details."
        >
          <SegmentedControl
            label="Density"
            value={appearance.density}
            options={densityOptions}
            onValueChange={(density) => update({ density })}
          />
        </SettingRow>
        <SettingRow {...settingRow("appearance.transcriptSize")}>
          <Select
            label="Transcript text size"
            value={appearance.transcriptSize}
            options={sizeOptions}
            onValueChange={(transcriptSize) => update({ transcriptSize })}
          />
        </SettingRow>
      </SettingSection>
    </>
  );
}
