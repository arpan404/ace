import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Slider } from "@/components/ui/slider.tsx";
import { HexColor, TranscriptSize, transcriptSizes, type Density } from "@/theme/appearance.ts";
import { accentNames, basePreset } from "@/theme/presets.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { ThemeCard } from "./theme-card.tsx";

const sizeOptions = TranscriptSize.options.map((value) => ({
  value,
  label: transcriptSizes[value].label,
}));
const densityOptions: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

/** Theme, glass, accent, density and transcript size. Every change applies immediately. */
export function AppearanceSettings() {
  const { appearance, update, themes } = useTheme();
  return (
    <>
      <SettingSection label="Theme">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid max-w-[760px] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3.5"
        >
          <ThemeCard
            name="System"
            selected={appearance.theme === "system"}
            system={{ light: basePreset("light"), dark: basePreset("dark") }}
            onSelect={() => update({ theme: "system" })}
          />
          {themes.map((theme) => (
            <ThemeCard
              key={theme.id}
              name={theme.name}
              theme={theme}
              custom={!theme.preset}
              selected={appearance.theme === theme.id}
              onSelect={() => update({ theme: theme.id })}
            />
          ))}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Edit any token or make your own theme in{" "}
          <Link to="/settings/theme-editor" className="font-medium text-foreground hover:underline">
            Advanced › Theme editor
          </Link>
        </p>
      </SettingSection>
      <SettingSection label="Material">
        <SettingRow
          title="Glass intensity"
          description="How much of your desktop shows through the rail, sidebar and floating panels. Follows Reduce transparency in your OS."
        >
          <span className="text-[12px] text-subtle-foreground">Solid</span>
          <Slider
            label="Glass intensity"
            min={0}
            max={100}
            value={Math.round(appearance.glass * 100)}
            onValueChange={(value) =>
              update({ glass: (typeof value === "number" ? value : 0) / 100 })
            }
          />
          <span className="text-[12px] text-subtle-foreground">Clear</span>
        </SettingRow>
        <SettingRow
          title="Accent colour"
          description="Used for focus, links, selection and the new-activity marker. Status colours never change."
        >
          <AccentPicker />
        </SettingRow>
        <SettingRow
          title="Density"
          description="Compact fits more threads and shorter cards in the sidebar."
        >
          <SegmentedControl
            label="Density"
            value={appearance.density}
            options={densityOptions}
            onValueChange={(density) => update({ density })}
          />
        </SettingRow>
        <SettingRow title="Transcript text size">
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

function AccentPicker() {
  const { appearance, update } = useTheme();
  const [hex, setHex] = useState(appearance.accent === "custom" ? appearance.customAccent : "");
  const swatch =
    "size-[22px] rounded-full outline-none transition-shadow duration-(--dur-1) focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)] aria-checked:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]";
  const custom = (value: string) => update({ accent: "custom", customAccent: value });
  return (
    <div role="radiogroup" aria-label="Accent colour" className="flex items-center gap-2">
      {accentNames.map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-label={name}
          aria-checked={appearance.accent === name}
          onClick={() => update({ accent: name })}
          className={swatch}
          style={{ background: `var(--accent-${name})` }}
        />
      ))}
      <label
        aria-label="Custom colour"
        className={cn(
          swatch,
          "relative overflow-hidden bg-[conic-gradient(#F07171,#F0B35E,#6CC48F,#7AA2F7,#B49CF5,#F07171)]",
          appearance.accent === "custom" &&
            "shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]",
        )}
      >
        <input
          type="color"
          value={appearance.customAccent}
          onChange={(event) => {
            setHex(event.target.value);
            custom(event.target.value);
          }}
          className="absolute -inset-1.5 size-10 cursor-pointer opacity-0"
        />
      </label>
      <input
        aria-label="Custom accent hex"
        placeholder="#hex"
        maxLength={7}
        value={hex}
        onChange={(event) => {
          setHex(event.target.value);
          if (HexColor.safeParse(event.target.value).success) custom(event.target.value);
        }}
        className="h-7 w-[84px] rounded-sm bg-secondary px-2 font-mono text-[12px] outline-none placeholder:text-subtle-foreground focus:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_40%,transparent)]"
      />
    </div>
  );
}
