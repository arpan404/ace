import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretUpIcon,
  PauseIcon,
  PlayIcon,
  ProhibitIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { AppForms } from "./app-forms.tsx";
import { DeviceLogLines, useDeviceLogs } from "./device-logs.tsx";
import {
  drawerHeights,
  setDrawerPrefs,
  useDrawerPrefs,
  type DrawerSection,
} from "./device-prefs.ts";
import type { DeviceSession } from "./device-session.ts";
import type { Bounds } from "./device-stage.tsx";
import { UiTree, useUiTree } from "./ui-tree.tsx";
import type { useDevices } from "./use-devices.ts";

const sections: readonly { value: DrawerSection; label: string }[] = [
  { value: "logs", label: "Logs" },
  { value: "tree", label: "UI tree" },
  { value: "app", label: "App" },
];

/**
 * The drawer under the stage: the device's logs, the UI tree agents read, and app install,
 * launch and open-URL forms. It folds down to its bar and remembers its height and section.
 * Logs stream and the tree is read only while their section shows.
 */
export function DeviceDrawer(props: {
  devices: ReturnType<typeof useDevices>;
  session: DeviceSession;
  deviceId: string;
  live: boolean;
  onHighlight(bounds: Bounds | undefined): void;
}) {
  const prefs = useDrawerPrefs();
  const [height, setHeight] = useState(prefs.height);
  const [filter, setFilter] = useState("");
  const { open, section } = prefs;
  const logs = useDeviceLogs(props.session, props.deviceId, open && section === "logs");
  const { tree, reload } = useUiTree(
    props.devices.uiTree,
    open && section === "tree" && props.live,
  );
  /** Show a section, unfolding the drawer; logs shown again start from an empty tail. */
  const show = (next: DrawerSection, unfold: boolean) => {
    if (next === "logs" && (unfold || section !== "logs")) logs.clear();
    setDrawerPrefs({ section: next, open: true });
  };
  return (
    <section
      aria-label="Device details"
      style={open ? { height } : undefined}
      className="relative flex shrink-0 flex-col border-t border-border bg-panel"
    >
      {open && (
        <ResizeHandle
          label="Resize the drawer"
          edge="top"
          size={height}
          min={drawerHeights.min}
          max={drawerHeights.max}
          onResize={setHeight}
          onResizeEnd={(next) => setDrawerPrefs({ height: next })}
        />
      )}
      <div className={cn("flex h-9 shrink-0 items-center gap-1 pr-1.5 pl-2", open && toolbarEdge)}>
        {/* Folded, any segment (the current one too) unfolds the drawer to it. */}
        <div
          onClickCapture={() => {
            if (!open) show(section, true);
          }}
        >
          <SegmentedControl
            size="sm"
            label="Device details"
            value={section}
            options={sections}
            onValueChange={(next) => show(next, false)}
          />
        </div>
        <span className="min-w-2 flex-1" />
        {open && section === "logs" && (
          <>
            <SearchField
              label="Filter logs"
              placeholder="Filter"
              value={filter}
              onValueChange={setFilter}
              className="h-6 max-w-40 min-w-24 flex-1 text-xs"
            />
            <IconButton
              size="sm"
              icon={logs.paused ? PlayIcon : PauseIcon}
              label={logs.paused ? "Resume logs" : "Pause logs"}
              pressed={logs.paused}
              onClick={() => logs.setPaused(!logs.paused)}
            />
            <IconButton size="sm" icon={ProhibitIcon} label="Clear logs" onClick={logs.clear} />
          </>
        )}
        {open && section === "tree" && (
          <IconButton
            size="sm"
            icon={ArrowClockwiseIcon}
            label="Read the screen again"
            disabled={!props.live}
            onClick={reload}
          />
        )}
        <IconButton
          size="sm"
          icon={open ? CaretDownIcon : CaretUpIcon}
          label={open ? "Fold the drawer" : "Unfold the drawer"}
          onClick={() => (open ? setDrawerPrefs({ open: false }) : show(section, true))}
        />
      </div>
      {open && (
        <div className="min-h-0 flex-1">
          {section === "logs" ? (
            <DeviceLogLines logs={logs} filter={filter} />
          ) : section === "tree" ? (
            props.live ? (
              <UiTree tree={tree} onReload={reload} onHighlight={props.onHighlight} />
            ) : (
              <p className="px-3 py-2 text-ui text-subtle-foreground">
                Start the live view to read the screen
              </p>
            )
          ) : (
            <div className="h-full overflow-auto">
              <AppForms
                disabled={
                  props.devices.view.pending || props.devices.view.controls?.running !== true
                }
                onInstall={props.devices.install}
                onLaunch={props.devices.openApp}
                onOpenUrl={props.devices.openUrl}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
