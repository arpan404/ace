import { ThemeChooser } from "./theme-chooser.tsx";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Slider } from "@/components/ui/slider.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { HexColor, TranscriptSize, transcriptSizes, type Density } from "@/theme/appearance.ts";
import { accentNames } from "@/theme/presets.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { settingRow } from "./settings-index.ts";

const sizeOptions = TranscriptSize.options.map((value) => ({
  value,
  label: transcriptSizes[value].label,
}));
const densityOptions: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Theme, glass, accent, density and transcript size. Every change applies immediately. */
export function AppearanceSettings() {
  const { appearance, update } = useTheme();
  return (
    <>
      <SettingSection label={settingRow("appearance.theme").title} scope="device">
        <ThemeChooser />
      </SettingSection>
      <SettingSection label="Display" card scope="device">
        <SettingRow {...settingRow("appearance.glass")} description={undefined}>
          <span className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Solid</span>
            <Slider
              label="Glass intensity"
              min={0}
              max={100}
              value={Math.round(appearance.glass * 100)}
              onValueChange={(value) =>
                update({ glass: (typeof value === "number" ? value : 0) / 100 })
              }
            />
            <span className="text-sm text-muted-foreground">Clear</span>
          </span>
        </SettingRow>
        <SettingRow {...settingRow("appearance.accent")} description={undefined}>
          <AccentPicker />
        </SettingRow>
        <SettingRow
          {...settingRow("appearance.density")}
          description="Spacing in settings, lists and Work details."
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
      <SettingSection label="Make your own" card scope="device">
        <SettingRow
          title={settingRow("appearance.themeEditor").title}
          id="appearance.themeEditor"
          inline
        >
          <Link
            to="/settings/theme-editor"
            aria-label="Open theme editor"
            className="flex h-7 items-center gap-1 rounded-sm text-sm text-muted-foreground focus-ring hover:text-foreground"
          >
            <CaretRightIcon aria-hidden size={14} />
          </Link>
        </SettingRow>
      </SettingSection>
    </>
  );
}

const swatch =
  "relative touch-hit touch-hit-lg size-5 pointer-coarse:size-11 shrink-0 rounded-full transition-shadow duration-(--dur-1) focus-ring aria-checked:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]";

function AccentPicker() {
  const { appearance, update } = useTheme();
  const [hex, setHex] = useState(appearance.customAccent);
  const [invalid, setInvalid] = useState(false);
  const custom = (value: string) => update({ accent: "custom", customAccent: value });
  const customChecked = appearance.accent === "custom";
  return (
    <div
      role="radiogroup"
      aria-label="Accent colour"
      onKeyDown={onRadioKeys}
      className="flex flex-wrap items-center justify-end gap-1.5"
    >
      {(["theme", ...accentNames] as const).map((name) => {
        const label = name === "theme" ? "Theme's own" : capitalised(name);
        return (
          <Tip key={name} label={label}>
            <button
              type="button"
              role="radio"
              aria-label={label}
              aria-checked={appearance.accent === name}
              tabIndex={appearance.accent === name ? 0 : -1}
              onClick={() => update({ accent: name })}
              className={swatch}
              style={{ background: `var(--accent-${name})` }}
            />
          </Tip>
        );
      })}
      <Tip label={`Custom colour (${appearance.customAccent.toUpperCase()})`}>
        <label
          className={cn(
            swatch,
            "relative overflow-hidden bg-[conic-gradient(#F07171,#F0B35E,#6CC48F,#7AA2F7,#B49CF5,#F07171)] has-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus,var(--ring))]",
            customChecked && "shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]",
          )}
        >
          <input
            type="color"
            role="radio"
            aria-checked={customChecked}
            aria-label={`Custom colour (${appearance.customAccent.toUpperCase()})`}
            tabIndex={customChecked ? 0 : -1}
            value={appearance.customAccent}
            onClick={() => !customChecked && custom(appearance.customAccent)}
            onChange={(event) => {
              setHex(event.target.value);
              setInvalid(false);
              custom(event.target.value);
            }}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
      </Tip>
      {customChecked && (
        <input
          aria-label="Custom accent hex"
          aria-invalid={invalid}
          placeholder="#hex"
          maxLength={7}
          value={hex}
          onChange={(event) => {
            setHex(event.target.value);
            if (HexColor.safeParse(event.target.value).success) {
              setInvalid(false);
              custom(event.target.value);
            }
          }}
          onBlur={() => setInvalid(!HexColor.safeParse(hex).success)}
          className="h-7 w-[84px] rounded-sm bg-secondary px-2 font-mono text-sm placeholder:text-subtle-foreground focus-ring aria-invalid:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--destructive)]"
        />
      )}
    </div>
  );
}
