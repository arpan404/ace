import { useId, type ReactNode } from "react";
import { AccentPicker } from "./accent-picker.tsx";
import { ModePicker } from "./mode-picker.tsx";
import { LookPicker } from "./look-picker.tsx";
import { useLook } from "./look.ts";
import { PreviewStrip } from "./preview-strip.tsx";
import {
  SettingRow,
  SettingSection,
  settingsGroup,
  SettingsGroupTitle,
} from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Slider } from "@/components/ui/slider.tsx";
import {
  TranscriptSize,
  themeHasGlass,
  transcriptSizes,
  type BackdropMotion,
  type Density,
  type ReduceMotion,
} from "@/theme/appearance.ts";
import { suitPalette } from "@/theme/suits/suit-css.ts";
import { themes } from "@ace/themes";
import { useTheme } from "@/theme/theme-provider.tsx";
import { snapTranslucency, translucencyMax, translucencyStep } from "@/theme/translucency.ts";
import { settingRow, type SettingId } from "./settings-index.ts";

const motionOptions: { value: ReduceMotion; label: string }[] = [
  { value: "system", label: "System" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];
const backdropOptions: { value: BackdropMotion; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "reduced", label: "Reduced" },
  { value: "still", label: "Still" },
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
    <section id={props.id} aria-labelledby={titleId} className={settingsGroup}>
      <SettingsGroupTitle id={titleId} note={settingRow(props.id).description}>
        {settingRow(props.id).title}
      </SettingsGroupTitle>
      <div className="pt-1">{props.children}</div>
    </section>
  );
}

/** "Solid" at 0, a percentage up to the most translucent glass. */
const translucencyText = (value: number) => (value === 0 ? "Solid" : `${value}%`);

/**
 * Translucency, from Solid to the theme's most translucent AA-safe glass. Floating layers follow
 * it live while it's dragged. Where layers are always
 * solid (a theme without glass, or the OS reducing transparency) it shows Solid, disabled,
 * and says why; the stored value is kept for later.
 */
function TranslucencyRow(props: {
  forcedSolid: string | undefined;
  value: number;
  onValueChange(value: number): void;
}) {
  const value = props.forcedSolid ? 0 : props.value;
  return (
    <SettingRow
      {...settingRow("appearance.translucency")}
      description={props.forcedSolid ?? settingRow("appearance.translucency").description}
    >
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

/**
 * Mode, look, accent, backdrop motion, translucency, motion, density and transcript size. Every
 * change applies at once; only the controls the picked look uses show.
 */
export function AppearanceSettings() {
  const { appearance, update, resolved, suit, systemReducesTransparency, softwareRendering } =
    useTheme();
  const look = useLook();
  const solidLook = suit
    ? suitPalette(suit.manifest, resolved.scheme).material.glass === null
      ? suit.manifest.name
      : undefined
    : themeHasGlass(appearance.theme, resolved.scheme)
      ? undefined
      : themes[appearance.theme].name;
  return (
    <>
      <PreviewStrip />
      <PickerGroup id="appearance.mode">
        <ModePicker />
      </PickerGroup>
      <PickerGroup id="appearance.look">
        <LookPicker />
      </PickerGroup>
      <PickerGroup id="appearance.accent">
        {look.summary && look.suitId !== null ? (
          <p className="text-ui text-muted-foreground">{look.summary.name} sets its own colours.</p>
        ) : (
          <AccentPicker />
        )}
      </PickerGroup>
      <SettingSection label="Display" card scope="device">
        {look.suitId !== null && look.summary?.scene && (
          <SettingRow {...settingRow("appearance.backdropMotion")}>
            <SegmentedControl
              label="Backdrop motion"
              value={appearance.backdropMotion}
              options={backdropOptions}
              onValueChange={(backdropMotion) => update({ backdropMotion })}
            />
          </SettingRow>
        )}
        <TranslucencyRow
          forcedSolid={
            solidLook
              ? `${solidLook} is always solid`
              : systemReducesTransparency
                ? "Solid while your system reduces transparency"
                : softwareRendering
                  ? "Solid while this device draws without graphics acceleration"
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
