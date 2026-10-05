import { SwatchesIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useState, type KeyboardEvent } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Slider } from "@/components/ui/slider.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { HexColor, TranscriptSize, transcriptSizes, type Density } from "@/theme/appearance.ts";
import { accentNames, basePreset } from "@/theme/presets.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { settingRow } from "./settings-index.ts";
import { ThemeCard } from "./theme-card.tsx";

const sizeOptions = TranscriptSize.options.map((value) => ({
  value,
  label: transcriptSizes[value].label,
}));
const densityOptions: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * Arrow keys for a radio group of buttons: one Tab stop (the checked one), ←/→ and ↑/↓ move
 * and choose, Home/End jump to the ends. Spread on the element with `role="radiogroup"`.
 */
function onRadioKeys(event: KeyboardEvent<HTMLElement>) {
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])'),
  ];
  const current = radios.indexOf(document.activeElement as HTMLElement);
  if (current === -1) return;
  const last = radios.length - 1;
  const next =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? current === last
        ? 0
        : current + 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? current === 0
          ? last
          : current - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  const target = radios[next];
  target?.focus();
  // A colour input opens its picker on click; it's chosen with Enter or Space instead.
  if (target && !(target instanceof HTMLInputElement)) target.click();
}

/** Theme, glass, accent, density and transcript size. Every change applies immediately. */
export function AppearanceSettings() {
  const { appearance, update, themes } = useTheme();
  return (
    <>
      <SettingSection label={settingRow("appearance.theme").title} scope="device">
        <div
          id="appearance.theme"
          role="radiogroup"
          aria-label="Theme"
          onKeyDown={onRadioKeys}
          className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3.5"
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
      </SettingSection>
      <SettingSection label="Material" card scope="device">
        <SettingRow
          {...settingRow("appearance.glass")}
          description="How much of your desktop shows through the rail, sidebar and floating panels. Follows Reduce transparency in your OS."
        >
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
        <SettingRow
          {...settingRow("appearance.accent")}
          description="Primary actions, links, selection, focus and sliders. Theme follows each theme's own accent. Status colours never change."
        >
          <AccentPicker />
        </SettingRow>
        <SettingRow
          {...settingRow("appearance.density")}
          description="Compact fits more rows in lists and settings."
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
          {...settingRow("appearance.themeEditor")}
          description="Every colour, glass and shape token, with import, export and contrast checks. Saved themes appear above."
          inline
        >
          <Link to="/settings/theme-editor" className={buttonVariants({ size: "sm" })}>
            <SwatchesIcon aria-hidden size={14} />
            Open theme editor
          </Link>
        </SettingRow>
      </SettingSection>
    </>
  );
}

const swatch =
  "size-[22px] shrink-0 rounded-full transition-shadow duration-(--dur-1) focus-ring aria-checked:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]";

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
      className="flex flex-wrap items-center gap-2"
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
            className="absolute -inset-1.5 size-10 cursor-pointer opacity-0"
          />
        </label>
      </Tip>
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
    </div>
  );
}
