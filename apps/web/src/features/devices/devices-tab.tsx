import type { DeviceRow } from "@ace/ui-core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { isEditable, useHotkey } from "@/lib/hotkeys.ts";
import { cn } from "@/lib/cn.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { CatalogMenu } from "./catalog-menu.tsx";
import { controllerOf } from "./controller-label.tsx";
import { deviceCatalog, type PlatformFilter } from "./device-catalog.ts";
import { DeviceGroups, RecentRows } from "./device-list-rows.tsx";
import { noteDeviceUse, requestBoot, useRecentUses } from "./device-prefs.ts";
import { Problem } from "./device-problem.tsx";
import { DisableDevicesDialog } from "./disable-devices-dialog.tsx";
import { RunningTiles } from "./running-tiles.tsx";
import { ToolReadiness, ToolSetupDialog } from "./tool-readiness.tsx";
import { useDevices } from "./use-devices.ts";

/** The workspace tab that shows one device (`device` kind, one tab per simulator or emulator). */
export const deviceTab = (row: Pick<DeviceRow, "id" | "name">) => ({
  kind: "device",
  id: row.id,
  title: row.name,
});

/** The wall clock, read once a minute, for "used 2h ago". */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const platforms: readonly { value: PlatformFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
];

function Section(props: { label: string; count?: number; children: ReactNode }) {
  return (
    <section aria-label={props.label} className="flex flex-col gap-1.5">
      <h3 className="flex items-baseline gap-1.5 px-2 text-ui font-medium text-muted-foreground">
        {props.label}
        {props.count !== undefined && (
          <span className="text-xs font-normal text-subtle-foreground tabular-nums">
            {props.count}
          </span>
        )}
      </h3>
      {props.children}
    </section>
  );
}

/**
 * Devices: the iOS Simulators and Android emulators on the daemon's machine. Running ones show
 * live as tiles, recently used ones follow, then every device by kind, all narrowed by the search
 * and the platform filter. Each device opens as its own tab.
 */
export function DevicesTab(props: { threadId: string }) {
  const devices = useDevices(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const workspace = useScopeWorkspace(props.threadId);
  const uses = useRecentUses();
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [setUp, setSetUp] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const search = useRef<HTMLDivElement>(null);
  const now = useMinute();
  const { view } = devices;
  const ready = view.connected && view.enabled;
  useHotkey("/", () => search.current?.querySelector("input")?.focus(), {
    enabled: ready,
    when: (event) => !isEditable(event.target),
  });
  const open = new Set(workspace.tabs.filter((tab) => tab.kind === "device").map((tab) => tab.id));
  const openDevice = (row: DeviceRow) => {
    noteDeviceUse(row.id, Date.now());
    actions.open(deviceTab(row));
  };

  if (!view.connected)
    return view.failure ? (
      <EmptyState
        title="Devices disconnected"
        description={`${view.failure.message} ${view.failure.hint}`.trim()}
        action={<Button onClick={devices.reconnect}>Reconnect</Button>}
      />
    ) : (
      <ListSkeleton label="Connecting to devices" shape="row" rows={4} className="px-4 pt-3" />
    );
  if (!view.enabled)
    return (
      <EmptyState
        title="Simulators and emulators"
        description="Watch and drive this machine's iOS Simulators and Android emulators, and let this thread's agents use them."
        action={
          <div className="flex flex-col items-center gap-3">
            <Button variant="primary" disabled={view.pending} onClick={() => devices.enable(true)}>
              Enable devices
            </Button>
            {view.problem && (
              <Problem
                problem={view.problem}
                className="max-w-[44ch] text-sm text-muted-foreground"
              />
            )}
          </div>
        }
      />
    );

  const catalog = deviceCatalog(view.rows, { query, platform, uses });
  const searching = query.trim() !== "" || platform !== "all";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-2", toolbarEdge)}>
        <div ref={search} className="min-w-0 flex-1">
          <SearchField
            label="Search devices"
            placeholder="Search devices"
            value={query}
            onValueChange={setQuery}
            className="h-7"
          />
        </div>
        <SegmentedControl<PlatformFilter>
          size="sm"
          label="Platform"
          value={platform}
          options={platforms}
          onValueChange={setPlatform}
        />
        <CatalogMenu
          pending={view.pending}
          onRefresh={devices.refresh}
          onSetUp={() => setSetUp(true)}
          onDisable={() => setDisabling(true)}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pt-3 pb-4">
        {view.problem && (
          <Problem problem={view.problem} className="px-2 text-sm text-muted-foreground" />
        )}
        {view.rows.length === 0 ? (
          view.pending || view.loading ? (
            <ListSkeleton label="devices" shape="row" rows={3} className="px-2" />
          ) : (
            <EmptyState
              variant="inline"
              className="px-2 pt-0"
              title="No simulators or emulators on this machine"
              description="Create one in Xcode or Android Studio, then refresh."
              action={
                <Button size="sm" onClick={devices.refresh}>
                  Refresh
                </Button>
              }
            />
          )
        ) : catalog.matches === 0 ? (
          <EmptyState
            variant="inline"
            className="px-2 pt-0"
            title="No devices match"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setQuery("");
                  setPlatform("all");
                }}
              >
                Clear search
              </Button>
            }
          />
        ) : (
          <>
            {catalog.running.length > 0 && (
              <Section label="Running" count={catalog.running.length}>
                <RunningTiles
                  rows={catalog.running}
                  session={view.session}
                  controllerOf={(row) =>
                    controllerOf(view.controllers.get(row.id) ?? { controller: "none" })
                  }
                  open={open}
                  onOpen={openDevice}
                />
              </Section>
            )}
            {catalog.recent.length > 0 && (
              <Section label="Recent">
                <RecentRows
                  recent={catalog.recent}
                  now={now}
                  open={open}
                  pending={view.pending}
                  onOpen={openDevice}
                  onBoot={(row) => {
                    requestBoot(row.id);
                    openDevice(row);
                  }}
                />
              </Section>
            )}
            <Section label="All devices" count={catalog.matches}>
              <DeviceGroups
                groups={catalog.groups}
                searching={searching}
                open={open}
                onOpen={openDevice}
              />
            </Section>
          </>
        )}
        {view.notes.map((note) => (
          <Problem
            key={note.message}
            problem={note}
            className="px-2 text-sm text-muted-foreground"
          />
        ))}
        {(view.toolsMissing || view.downloadingTools) && (
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={view.downloadingTools}
            onClick={devices.downloadTools}
          >
            {view.downloadingTools ? "Downloading device tools…" : "Download device tools"}
          </Button>
        )}
        <div className="mt-auto px-2">
          <ToolReadiness onSetUp={() => setSetUp(true)} />
        </div>
      </div>
      <ToolSetupDialog open={setUp} onOpenChange={setSetUp} />
      <DisableDevicesDialog
        open={disabling}
        onOpenChange={setDisabling}
        onDisable={() => devices.enable(false)}
      />
    </div>
  );
}
