import { useId, type ReactNode } from "react";
import { AccentPicker } from "./accent-picker.tsx";
import { ModePicker } from "./mode-picker.tsx";
import { ThemeChooser } from "./theme-chooser.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import {
  TranscriptSize,
  transcriptSizes,
  type Density,
  type ReduceMotion,
  type SurfaceSetting,
} from "@/theme/appearance.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { settingRow, type SettingId } from "./settings-index.ts";

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

/** A titled group of picker cards, outside the row cards; its id is the settings deep link. */
function PickerGroup(props: { id: SettingId; children: ReactNode }) {
  const titleId = useId();
  return (
    <section id={props.id} aria-labelledby={titleId} className="mt-8 flex flex-col gap-3">
      <h3 id={titleId} className="px-1 text-ui font-medium text-foreground">
        {settingRow(props.id).title}
      </h3>
      {props.children}
    </section>
  );
}

/** Mode, theme, surfaces, motion, density and transcript size. Every change applies at once. */
export function AppearanceSettings() {
  const { appearance, update, systemReducesTransparency } = useTheme();
  return (
    <>
      <PickerGroup id="appearance.mode">
        <ModePicker />
      </PickerGroup>
      <PickerGroup id="appearance.theme">
        <ThemeChooser />
      </PickerGroup>
      <PickerGroup id="appearance.accent">
        <AccentPicker />
      </PickerGroup>
      <SettingSection label="Display" card scope="device">
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
