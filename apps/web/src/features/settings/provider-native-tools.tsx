import type { NativeToolStatus, ProviderKind, ProviderStatus } from "@ace/protocol";
import type { GlyphState } from "@ace/ui-core";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { cn } from "@/lib/cn.ts";
import { CodexToolSourceRow } from "./codex-tool-source.tsx";
import { useWatchedSettingControl } from "./data/use-settings.ts";
import { DaemonSlot } from "./setting-control.tsx";
import { settingRow } from "./settings-index.ts";

/** How each state reads: its words, its still glyph and the ink the words take. */
const looks: Record<
  NativeToolStatus["state"],
  { words: string; glyph: GlyphState; className: string }
> = {
  ready: { words: "Ready", glyph: "done", className: "text-muted-foreground" },
  unavailable: { words: "Unavailable", glyph: "needs-you", className: "text-status-needs-you" },
  unknown: { words: "Not checked", glyph: "idle", className: "text-muted-foreground" },
};

const chromeOptions = [
  { value: "auto", label: "Auto" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

/**
 * A provider's own tools (ADR 0138), as its status row reports them for the selected account:
 * one row per tool with its state, Claude in Chrome's switch, and the folder Codex accounts take
 * their plugins and tools from. Absent when the daemon reports none.
 */
export function ProviderNativeTools(props: {
  provider: ProviderKind;
  name: string;
  row: ProviderStatus;
}) {
  const tools = props.row.nativeTools;
  if (!tools?.length) return null;
  return (
    <SettingSection label={`${props.name}'s own tools`}>
      {props.provider === "codex" && props.row.toolSource && (
        <CodexToolSourceRow source={props.row.toolSource} />
      )}
      {tools.map((tool) =>
        props.provider === "claude" && tool.id === "chrome" ? (
          <ClaudeChromeRow key={tool.id} tool={tool} />
        ) : (
          <SettingRow key={tool.id} title={tool.label} description={tool.reason} inline>
            <ToolState state={tool.state} />
          </SettingRow>
        ),
      )}
    </SettingSection>
  );
}

function ToolState(props: { state: NativeToolStatus["state"] }) {
  const look = looks[props.state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", look.className)}>
      <StatusGlyph state={look.glyph} />
      {look.words}
    </span>
  );
}

/** Claude in Chrome: Auto follows Claude's own setting, and the reason says what that is. */
function ClaudeChromeRow(props: { tool: NativeToolStatus }) {
  const row = settingRow("providers.claude.chrome");
  const control = useWatchedSettingControl("providers.claude.chrome", props.tool.label);
  const look = looks[props.tool.state];
  return (
    <SettingRow
      id={row.id}
      title={props.tool.label}
      description={
        <span className={cn("flex items-start gap-1.5", look.className)}>
          <StatusGlyph state={look.glyph} size={12} className="mt-[3px]" />
          <span>{props.tool.reason ?? look.words}</span>
        </span>
      }
      inline
    >
      <DaemonSlot control={control}>
        <SegmentedControl
          label={props.tool.label}
          size="sm"
          value={control.value ?? "auto"}
          options={chromeOptions}
          disabled={control.offline}
          onValueChange={(next) => control.set(next)}
        />
      </DaemonSlot>
    </SettingRow>
  );
}
