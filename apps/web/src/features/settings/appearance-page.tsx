import { useId, type ReactNode } from "react";
import { AccentPicker } from "./accent-picker.tsx";
import { ModePicker } from "./mode-picker.tsx";
import { ThemeChooser } from "./theme-chooser.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Slider } from "@/components/ui/slider.tsx";
import {
  TranscriptSize,
  themeHasGlass,
  transcriptSizes,
  type Density,
  type ReduceMotion,
} from "@/theme/appearance.ts";
import { themes } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { snapTranslucency, translucencyMax, translucencyStep } from "@/theme/translucency.ts";
import { settingRow, type SettingId } from "./settings-index.ts";

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

/** "Solid" at 0, else the percentage of the theme's most translucent glass. */
const translucencyText = (value: number) => (value === 0 ? "Solid" : `${value}%`);

/**
 * Translucency, from Solid to the theme's most translucent AA-safe glass. Floating layers follow
 * it live while it's dragged. Where layers are always solid (Signal, or the OS reducing
 * transparency) it shows Solid, disabled, and says why; the stored value is kept for later.
 */
function TranslucencyRow(props: {
  forcedSolid: string | undefined;
  value: number;
  onValueChange(value: number): void;
}) {
  const value = props.forcedSolid ? 0 : props.value;
  return (
    <SettingRow {...settingRow("appearance.translucency")} description={props.forcedSolid}>
      <Slider
        label="Translucency"
        min={0}
        max={translucencyMax}
        step={translucencyStep}
        value={value}
        disabled={props.forcedSolid !== undefined}
        valueText={translucencyText}
        onValueChange={(next) => props.onValueChange(snapTranslucency(next))}
      />
      <span
        aria-hidden="true"
        className="w-10 text-right text-xs text-muted-foreground tabular-nums"
      >
        {translucencyText(value)}
      </span>
    </SettingRow>
  );
}

/** Mode, theme, translucency, motion, density and transcript size. Every change applies at once. */
export function AppearanceSettings() {
  const { appearance, update, resolved, systemReducesTransparency } = useTheme();
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
        <TranslucencyRow
          forcedSolid={
            !themeHasGlass(appearance.theme, resolved.scheme)
              ? `${themes[appearance.theme].name} is always solid`
              : systemReducesTransparency
                ? "Solid while your system reduces transparency"
                : undefined
          }
          value={appearance.translucency}
          onValueChange={(translucency) => update({ translucency })}
        />
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
