import { XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle, clampSize } from "@/components/ui/resize-handle.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { useLayout, type PanelSide } from "@/lib/layout.tsx";

export interface PanelTab {
  id: string;
  label: string;
  /** Inline after the label, e.g. the diff stat on Changes. */
  badge?: ReactNode;
  /** A shortcut that opens this tab (and closes the panel when it is already showing). */
  shortcut?: KeymapId;
  content: ReactNode;
}
export interface PanelDefinition {
  label: string;
  tabs: readonly PanelTab[];
  /** Buttons at the right of the tab strip (new terminal, clear, …). */
  actions?: ReactNode;
}

function useViewport() {
  return useSyncExternalStore(
    (changed) => {
      addEventListener("resize", changed);
      return () => removeEventListener("resize", changed);
    },
    () => `${innerWidth}x${innerHeight}`,
    () => "1440x900",
  );
}

const bounds = (side: PanelSide, viewport: string) => {
  const [width = 1440, height = 900] = viewport.split("x").map(Number);
  // Right: 320px .. viewport − 600. Bottom: 120px .. 60vh (DESIGN-fable.md 5b).
  return side === "right"
    ? { min: 320, max: Math.max(320, width - 600) }
    : { min: 120, max: Math.max(120, Math.round(height * 0.6)) };
};

/**
 * A resizable tabbed panel on the right of or below the content. Open state, active tab and
 * size live in the shell layout and persist; the content column reflows around it.
 */
export function ShellPanel(props: { side: PanelSide; panel: PanelDefinition }) {
  const { layout, setTab, setPanelOpen, setPanelSize, toggleTab } = useLayout();
  const state = layout[props.side];
  const viewport = useViewport();
  const { min, max } = bounds(props.side, viewport);
  const size = clampSize(state.size, min, max);
  const right = props.side === "right";
  const active = props.panel.tabs.some((tab) => tab.id === state.tab)
    ? state.tab
    : (props.panel.tabs[0]?.id ?? state.tab);
  const shortcuts = props.panel.tabs.map(
    (tab) =>
      tab.shortcut && (
        <TabShortcut
          key={tab.id}
          keys={keymap[tab.shortcut].keys}
          onPress={() => toggleTab(props.side, tab.id)}
        />
      ),
  );
  if (!state.open) return shortcuts;
  return (
    <>
      {shortcuts}
      <section
        aria-label={props.panel.label}
        style={right ? { width: size } : { height: size }}
        className={cn(
          "relative flex min-h-0 min-w-0 shrink-0 flex-col bg-panel",
          right ? "border-l" : "border-t",
        )}
      >
        <ResizeHandle
          label={`Resize ${props.panel.label.toLowerCase()}`}
          edge={right ? "left" : "top"}
          size={size}
          min={min}
          max={max}
          onResize={(next) => setPanelSize(props.side, next)}
          onResizeEnd={(next) => setPanelSize(props.side, next, true)}
        />
        <Tabs
          value={active}
          onValueChange={(value) => setTab(props.side, String(value))}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex h-10 shrink-0 items-center gap-0.5 border-b pr-1.5 pl-2">
            <TabsList aria-label={props.panel.label} className="min-w-0 flex-1">
              {props.panel.tabs.map((tab) => (
                <TabsTab key={tab.id} value={tab.id}>
                  {tab.label}
                  {tab.badge}
                </TabsTab>
              ))}
            </TabsList>
            {props.panel.actions}
            <IconButton
              icon={XIcon}
              label={`Close ${props.panel.label.toLowerCase()}`}
              size="sm"
              onClick={() => setPanelOpen(props.side, false)}
            />
          </div>
          {props.panel.tabs.map((tab) => (
            <TabsPanel key={tab.id} value={tab.id} className="overflow-auto">
              {tab.content}
            </TabsPanel>
          ))}
        </Tabs>
      </section>
    </>
  );
}

function TabShortcut(props: { keys: string; onPress(): void }) {
  useHotkey(props.keys, props.onPress);
  return null;
}
