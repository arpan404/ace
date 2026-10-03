import { XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Activity, useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle, clampSize } from "@/components/ui/resize-handle.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { useLayout, type PanelSide } from "@/lib/layout.tsx";
import { overlayPanelsQuery, usePhone } from "@/lib/breakpoints.ts";
import { useMediaQuery } from "@/lib/media.ts";
import { panelMotion, usePresence } from "@/lib/motion.ts";

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

const bounds = (side: PanelSide, viewport: string, overlay: boolean) => {
  const [width = 1440, height = 900] = viewport.split("x").map(Number);
  // Right: 320px .. viewport − 600. Bottom: 120px .. 60vh (DESIGN-fable.md 5b). Floating, the
  // right panel may cover all but a 48px strip of the column.
  if (side === "right")
    return overlay
      ? { min: Math.min(320, width - 48), max: Math.max(280, width - 48) }
      : { min: 320, max: Math.max(320, width - 600) };
  return { min: 120, max: Math.max(120, Math.round(height * 0.6)) };
};

/**
 * A resizable tabbed panel on the right of or below the content. Open state, active tab and
 * size live in the shell layout and persist; the content column reflows around it, or, on
 * narrow windows, the panel floats over the content. Opening slides it a short way in from its
 * edge; closing fades it out before the column reflows.
 */
export function ShellPanel(props: { side: PanelSide; panel: PanelDefinition }) {
  const { layout, setTab, setPanelOpen, setPanelSize, toggleTab, setRightPanelShown } = useLayout();
  const state = layout[props.side];
  const viewport = useViewport();
  const overlay = useMediaQuery(overlayPanelsQuery, false);
  // On a phone either panel is a sheet over the whole content area, rising from the bottom.
  const sheet = usePhone();
  const right = props.side === "right";
  useEffect(() => {
    if (!right) return;
    setRightPanelShown(state.open);
    return () => setRightPanelShown(false);
  }, [right, state.open, setRightPanelShown]);
  const { min, max } = bounds(props.side, viewport, overlay);
  const size = clampSize(state.size, min, max);
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
  const presence = usePresence(state.open);
  if (!presence.mounted) return shortcuts;
  const closing = presence.phase === "exit";
  return (
    <>
      {shortcuts}
      <section
        aria-label={closing ? undefined : props.panel.label}
        inert={closing}
        data-edge={right && !sheet ? "right" : "bottom"}
        style={sheet ? undefined : right ? { width: size } : { height: size }}
        data-overlay={overlay || sheet || undefined}
        className={cn(
          "relative flex min-h-0 min-w-0 shrink-0 flex-col bg-panel",
          sheet
            ? "absolute inset-0 z-30 rounded-t-xl border-t bg-background shadow-[0_-12px_32px_rgb(0_0_0/0.22)]"
            : [
                right ? "border-l" : "border-t",
                overlay &&
                  (right
                    ? "absolute inset-y-0 right-0 z-20 max-w-[calc(100%-3rem)] bg-background shadow-[-12px_0_32px_rgb(0_0_0/0.18)]"
                    : "absolute inset-x-0 bottom-0 z-20 bg-background shadow-[0_-12px_32px_rgb(0_0_0/0.18)]"),
              ],
          panelMotion(presence),
        )}
      >
        {!sheet && (
          <ResizeHandle
            label={`Resize ${props.panel.label.toLowerCase()}`}
            edge={right ? "left" : "top"}
            size={size}
            min={min}
            max={max}
            onResize={(next) => setPanelSize(props.side, next)}
            onResizeEnd={(next) => setPanelSize(props.side, next, true)}
          />
        )}
        <Tabs
          value={active}
          onValueChange={(value) => setTab(props.side, String(value))}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5 border-b pr-1.5 pl-2",
              sheet ? "h-12 pr-2" : "h-10",
            )}
          >
            {/* The tabs scroll sideways rather than run under the actions and the close. */}
            <TabsList
              aria-label={props.panel.label}
              className="mr-1.5 min-w-0 flex-1 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]"
            >
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
              size={sheet ? "default" : "sm"}
              onClick={() => setPanelOpen(props.side, false)}
            />
          </div>
          {props.panel.tabs.map((tab) => (
            // Tabs not showing keep their state but pause: effects (subscriptions, terminals,
            // GPU views) stop and updates render at idle priority until the tab is shown.
            <TabsPanel key={tab.id} value={tab.id} keepMounted className="overflow-auto">
              <Activity mode={tab.id === active ? "visible" : "hidden"}>{tab.content}</Activity>
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
