import { useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  autoSaveDelays,
  editorFontSizes,
  editorLineSpacings,
  editorTabSizes,
  useEditorPreferences,
  type AutoSaveMode,
  type EditorPreferences,
} from "@/lib/editor-preferences.ts";
import { settingRow, type SettingId } from "./settings-index.ts";

const autoSaveOptions: { value: AutoSaveMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "pause", label: "After a pause" },
  { value: "focus", label: "When focus leaves" },
];
const delayOptions = autoSaveDelays.map((ms) => ({
  value: String(ms),
  label: ms < 1000 ? `${ms} ms` : `${ms / 1000} s`,
}));
const sizeOptions = editorFontSizes.map((size) => ({ value: String(size), label: `${size}px` }));
const spacingOptions = editorLineSpacings.map((each) => ({
  value: String(each.value),
  label: each.label,
}));
const tabOptions = editorTabSizes.map((size) => ({ value: String(size), label: String(size) }));
const indentOptions = [
  { value: "spaces", label: "Spaces" },
  { value: "tabs", label: "Tabs" },
] as const;

/**
 * How the code editor looks and saves on this device: auto save, the text's font, size and
 * spacing, the indentation a file without its own falls back to, and what is drawn around the
 * text. Every change shows in open editors at once.
 */
export function EditorSettings() {
  const [preferences, update] = useEditorPreferences();
  return (
    <>
      <SettingSection label="Saving" card scope="device">
        <SettingRow {...settingRow("editor.autoSave")}>
          <SegmentedControl
            label="Auto save"
            value={preferences.autoSave}
            options={autoSaveOptions}
            onValueChange={(autoSave) => update({ autoSave })}
          />
        </SettingRow>
        {preferences.autoSave === "pause" && (
          <SettingRow {...settingRow("editor.autoSaveDelay")}>
            <Select
              label="Save after"
              value={String(preferences.autoSaveDelay)}
              options={withCurrent(delayOptions, preferences.autoSaveDelay, (ms) => `${ms} ms`)}
              onValueChange={(value) => update({ autoSaveDelay: Number(value) })}
            />
          </SettingRow>
        )}
      </SettingSection>
      <SettingSection label="Text" card scope="device">
        <SettingRow {...settingRow("editor.fontSize")}>
          <Select
            label="Font size"
            value={String(preferences.fontSize)}
            options={withCurrent(sizeOptions, preferences.fontSize, (size) => `${size}px`)}
            onValueChange={(value) => update({ fontSize: Number(value) })}
          />
        </SettingRow>
        <SettingRow {...settingRow("editor.lineSpacing")}>
          <SegmentedControl
            label="Line height"
            value={String(preferences.lineSpacing)}
            options={withCurrent(spacingOptions, preferences.lineSpacing, (value) => `${value}×`)}
            onValueChange={(value) => update({ lineSpacing: Number(value) })}
          />
        </SettingRow>
        <FontFamilyRow
          value={preferences.fontFamily}
          onCommit={(fontFamily) => update({ fontFamily })}
        />
      </SettingSection>
      <SettingSection label="Indentation" card scope="device">
        <SettingRow {...settingRow("editor.tabSize")}>
          <SegmentedControl
            label="Tab size"
            value={String(preferences.tabSize)}
            options={withCurrent(tabOptions, preferences.tabSize, String)}
            onValueChange={(value) => update({ tabSize: Number(value) })}
          />
        </SettingRow>
        <SettingRow {...settingRow("editor.insertSpaces")}>
          <SegmentedControl
            label="Indent with"
            value={preferences.insertSpaces ? "spaces" : "tabs"}
            options={indentOptions}
            onValueChange={(value) => update({ insertSpaces: value === "spaces" })}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection label="Display" card scope="device">
        <SwitchRow entry="editor.wordWrap" field="wordWrap" />
        <SwitchRow entry="editor.renderWhitespace" field="renderWhitespace" />
        <SwitchRow entry="editor.indentGuides" field="indentGuides" />
        <SwitchRow entry="editor.stickyScroll" field="stickyScroll" />
        <SwitchRow entry="editor.cursorBlinking" field="cursorBlinking" />
      </SettingSection>
    </>
  );
}

type BooleanField = {
  [Key in keyof EditorPreferences]: EditorPreferences[Key] extends boolean ? Key : never;
}[keyof EditorPreferences];

/** One on/off preference as a switch row. */
function SwitchRow(props: { entry: SettingId; field: BooleanField }) {
  const id = useId();
  const [preferences, update] = useEditorPreferences();
  const row = settingRow(props.entry);
  return (
    <SettingRow {...row} htmlFor={id} inline>
      <Switch
        id={id}
        checked={preferences[props.field]}
        onCheckedChange={(checked) => update({ [props.field]: checked })}
      />
    </SettingRow>
  );
}

/** The font family, kept as typed and applied when the field is left or Enter is pressed. */
function FontFamilyRow(props: { value: string; onCommit(value: string): void }) {
  const id = useId();
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? props.value;
  const commit = () => {
    if (draft === undefined) return;
    setDraft(undefined);
    if (draft.trim() !== props.value) props.onCommit(draft.trim());
  };
  return (
    <SettingRow {...settingRow("editor.fontFamily")} htmlFor={id}>
      <Input
        id={id}
        value={shown}
        placeholder="Default monospace"
        spellCheck={false}
        maxLength={300}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(undefined);
        }}
        className="h-7 w-56 font-mono text-xs"
      />
    </SettingRow>
  );
}

/** The options, plus the stored value when it isn't one of them (set by an older build). */
function withCurrent<T extends string>(
  options: readonly { value: T; label: string }[],
  current: number,
  label: (value: number) => string,
): { value: string; label: string }[] {
  return options.some((option) => option.value === String(current))
    ? [...options]
    : [...options, { value: String(current), label: label(current) }];
}
