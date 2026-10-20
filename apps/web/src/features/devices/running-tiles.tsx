import type { DeviceRow } from "@ace/ui-core";
import { AndroidLogoIcon, AppleLogoIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cardEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { bodyTurn, deviceButtons } from "./device-buttons.ts";
import { deviceKind } from "./device-catalog.ts";
import { DeviceFrame } from "./device-frame.tsx";
import { defaultScreens, frameGeometry, framePoints, type Size } from "./device-frame-geometry.ts";
import { DeviceScreen } from "./device-screen.tsx";
import type { DeviceSession } from "./device-session.ts";
import { ControllerLabel, type Controller } from "./controller-label.tsx";
import { useElementSize, useOnScreen } from "./use-element-size.ts";

/** The most running devices shown before "Show all running". */
const tileLimit = 4;
/** Room for a tile's device when the page can't measure it (tests, a hidden panel). */
const fallbackRoom = { width: 136, height: 144 };

const noInput = () => {};

/**
 * One running device as a tile: its live screen, small, inside its drawn frame (watched only
 * while the tile is on screen), "Live" while it streams, then its name, OS and who drives it.
 */
function RunningTile(props: {
  row: DeviceRow;
  session: DeviceSession | undefined;
  controller: Controller;
  open: boolean;
  onOpen(): void;
}) {
  const { row, session } = props;
  const kind = deviceKind(row);
  const preview = useRef<HTMLDivElement>(null);
  const measured = useElementSize(preview);
  const visible = useOnScreen(preview);
  const [screen, setScreen] = useState<Size>(defaultScreens[kind]);
  const watching = visible && row.live && session !== undefined;
  useEffect(() => {
    if (!watching || !session) return;
    return session.client.retainStream(row.id);
  }, [watching, session, row.id]);
  // Drawn only: the tile is itself a button.
  const turn = bodyTurn(row.platform, screen, 0);
  const hardware = { buttons: deviceButtons(kind, row.name, turn), turn };
  const room =
    measured.width > 0 && measured.height > 0
      ? { width: measured.width - 24, height: measured.height - 24 }
      : fallbackRoom;
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={props.onOpen}
        aria-label={`${row.name}, ${[row.runtime, row.live ? "Live" : "Running"].filter(Boolean).join(", ")}`}
        className={cn(
          "group/tile relative flex w-full flex-col overflow-hidden rounded-lg text-left transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
          props.open && "bg-active hover:bg-active",
        )}
      >
        <div
          ref={preview}
          className="relative grid h-44 w-full place-items-center bg-(--device-stage)"
        >
          <DeviceFrame
            geometry={frameGeometry(kind, row.name, screen)}
            screen={screen}
            room={room}
            hardware={hardware}
          >
            {watching && session ? (
              <DeviceScreen
                session={session}
                deviceId={row.id}
                name={row.name}
                interactive={false}
                onInput={noInput}
                onFrame={(header) => {
                  const next = framePoints(header);
                  setScreen((before) =>
                    Math.abs(before.width / before.height - next.width / next.height) < 0.001
                      ? before
                      : next,
                  );
                }}
                className="pointer-events-none h-full max-h-none w-full max-w-none rounded-none shadow-none"
              />
            ) : (
              <span className="grid size-full place-items-center">
                <Icon
                  icon={row.platform === "ios" ? AppleLogoIcon : AndroidLogoIcon}
                  size={20}
                  className="text-faint-foreground"
                />
              </span>
            )}
          </DeviceFrame>
          {row.live && (
            <span className="absolute top-2 left-2 inline-flex h-5 items-center gap-1 rounded-full bg-background px-1.5 text-2xs font-medium text-foreground shadow-(--depth-raise)">
              <span aria-hidden className="size-1.5 rounded-full bg-foreground" />
              Live
            </span>
          )}
        </div>
        <span className="flex w-full flex-col gap-0.5 px-3 pt-2 pb-2.5">
          <span className="truncate text-ui font-medium text-foreground">{row.name}</span>
          <span className="truncate text-meta text-subtle-foreground">
            {row.runtime ?? (row.platform === "ios" ? "iOS" : "Android")}
          </span>
          <ControllerLabel
            controller={props.controller}
            className="flex min-w-0 text-meta text-muted-foreground"
          />
        </span>
        {/* Over the stage too, so the tile's edge runs all the way round. */}
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-0 rounded-lg", cardEdge)}
        />
      </button>
    </li>
  );
}

/** The running devices as live tiles in a grid that reflows with the panel; four, then more. */
export function RunningTiles(props: {
  rows: readonly DeviceRow[];
  session: DeviceSession | undefined;
  controllerOf(row: DeviceRow): Controller;
  open: ReadonlySet<string>;
  onOpen(row: DeviceRow): void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? props.rows : props.rows.slice(0, tileLimit);
  return (
    <div className="flex flex-col gap-2">
      <ul
        aria-label="Running devices"
        className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2"
      >
        {shown.map((row) => (
          <RunningTile
            key={row.id}
            row={row}
            session={props.session}
            controller={props.controllerOf(row)}
            open={props.open.has(row.id)}
            onOpen={() => props.onOpen(row)}
          />
        ))}
      </ul>
      {props.rows.length > tileLimit && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => setAll((value) => !value)}
        >
          {all ? "Show fewer" : `Show all running (${props.rows.length})`}
        </Button>
      )}
    </div>
  );
}
