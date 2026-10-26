import { DeviceRotateIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { Select, type SelectOption } from "@/components/ui/select.tsx";
import { cn } from "@/lib/cn.ts";
import {
  clampDimension,
  devicePresets,
  deviceScales,
  responsive,
} from "@ace/ui-core/browser-devices";
import type { PageTools } from "./use-page-tools.ts";

const presetOptions: readonly SelectOption<string>[] = [
  { value: responsive, label: "Responsive" },
  ...devicePresets.map((preset) => ({ value: preset.id, label: preset.label })),
];

const scaleOptions: readonly SelectOption<string>[] = deviceScales.map((scale) => ({
  value: String(scale),
  label: scale === "fit" ? "Fit" : `${Math.round(scale * 100)}%`,
}));

/** One side of the size: shows the value, takes a new one on Enter or leaving the field. */
function Dimension(props: { label: string; value: number; onCommit(value: number): void }) {
  const [draft, setDraft] = useState<string>();
  const commit = () => {
    if (draft === undefined) return;
    const parsed = Number.parseInt(draft, 10);
    setDraft(undefined);
    if (Number.isFinite(parsed) && clampDimension(parsed) !== props.value)
      props.onCommit(clampDimension(parsed));
  };
  return (
    <Input
      aria-label={props.label}
      inputMode="numeric"
      value={draft ?? String(props.value)}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, "").slice(0, 4))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && draft !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          setDraft(undefined);
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const step = (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
          props.onCommit(clampDimension(props.value + step));
        }
      }}
      className="h-7 w-14 px-1.5 text-center text-xs tabular-nums"
    />
  );
}

/**
 * The device toolbar under the page's toolbar: the device (Responsive or a phone, tablet or
 * computer), its width and height, rotate, how large it is drawn, and close. Typing a size
 * makes it Responsive, as in a browser's own device toolbar.
 */
export function DeviceToolbar(props: { tools: PageTools }) {
  const { tools } = props;
  const size = tools.size;
  return (
    <div
      role="toolbar"
      aria-label="Device toolbar"
      className={cn("flex h-9 shrink-0 items-center gap-1.5 px-2", toolbarEdge)}
    >
      <Select
        label="Device"
        value={size?.preset ?? responsive}
        options={presetOptions}
        onValueChange={tools.choosePreset}
        className="h-7 w-44 text-xs"
      />
      {size && (
        <span className="flex items-center gap-1 text-xs text-subtle-foreground">
          <Dimension
            label="Width"
            value={size.width}
            onCommit={(width) => tools.resize(width, size.height)}
          />
          <span aria-hidden>×</span>
          <Dimension
            label="Height"
            value={size.height}
            onCommit={(height) => tools.resize(size.width, height)}
          />
        </span>
      )}
      <IconButton
        icon={DeviceRotateIcon}
        label="Rotate"
        size="sm"
        disabled={!size}
        onClick={tools.rotate}
      />
      <span className="flex-1" />
      <Select
        label="Device scale"
        value={String(tools.scale)}
        options={scaleOptions}
        onValueChange={(value) => tools.setScale(value === "fit" ? "fit" : Number(value))}
        className="h-7 w-20 text-xs"
      />
      <IconButton
        icon={XIcon}
        label="Close device toolbar"
        size="sm"
        onClick={() => tools.showToolbar(false)}
      />
    </div>
  );
}
