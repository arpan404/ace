import type { DeviceInput, ScreenFrameHeader } from "@ace/protocol";
import type { DeviceRow } from "@ace/ui-core";
import { useRef, useState, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn.ts";
import { ActivityRipple, type ShownActivity } from "./activity-overlay.tsx";
import { screenFraction } from "./agent-activity.ts";
import { deviceKind } from "./device-catalog.ts";
import { bareGeometry, DeviceFrame } from "./device-frame.tsx";
import { defaultScreens, frameGeometry, framePoints, type Size } from "./device-frame-geometry.ts";
import { DeviceScreen } from "./device-screen.tsx";
import type { DeviceSession } from "./device-session.ts";
import { useElementSize } from "./use-element-size.ts";

/** Room for the device when the page can't measure the stage (tests, a hidden panel). */
const fallbackRoom = { width: 280, height: 560 };

/** An element's bounds in device points, outlined over the screen while its tree row is hovered. */
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function BoundsOutline(props: { bounds: Bounds; screen: Size }) {
  const start = screenFraction(props.bounds, props.screen);
  const end = screenFraction(
    { x: props.bounds.x + props.bounds.w, y: props.bounds.y + props.bounds.h },
    props.screen,
  );
  if (!start || !end) return null;
  return (
    <span
      aria-hidden
      data-bounds-outline=""
      // Two tones, the page's ground inside its ink, so the outline reads on any screen content.
      className="pointer-events-none absolute rounded-xs border-2 border-background bg-foreground/10 outline-1 outline-foreground"
      style={{
        left: `${start.x * 100}%`,
        top: `${start.y * 100}%`,
        width: `${(end.x - start.x) * 100}%`,
        height: `${(end.y - start.y) * 100}%`,
      }}
    />
  );
}

/**
 * The stage: the live screen inside a frame drawn for its kind of device (or the screen alone),
 * centred and scaled to fit with its aspect kept, on a calm surface. Over it: the agent's taps,
 * the hovered element's bounds, the control rail on the right, and at the bottom the keyboard
 * field and the agent's caption. A device that isn't streaming shows its frame dimmed and `idle`
 * (what to do next) over it.
 */
export function DeviceStage({
  ref,
  ...props
}: {
  ref: Ref<HTMLDivElement>;
  row: DeviceRow;
  session: DeviceSession;
  live: boolean;
  interactive: boolean;
  bare: boolean;
  onInput(input: DeviceInput): void | Promise<void>;
  onFrame(header: ScreenFrameHeader): void;
  activity: ShownActivity | undefined;
  highlight: Bounds | undefined;
  idle?: ReactNode;
  rail?: ReactNode;
  /** The keyboard field and the agent's caption, bottom centre. */
  footer?: ReactNode;
}) {
  const { row } = props;
  const kind = deviceKind(row);
  const room = useRef<HTMLDivElement>(null);
  const measured = useElementSize(room);
  const [screen, setScreen] = useState<Size>(defaultScreens[kind]);
  const fit = measured.width > 0 && measured.height > 0 ? measured : fallbackRoom;
  const geometry = props.bare ? bareGeometry : frameGeometry(kind, row.name, screen);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="relative min-h-0 flex-1 overflow-hidden bg-(--device-stage)"
    >
      <div ref={room} className="absolute inset-x-16 inset-y-5 grid place-items-center">
        <DeviceFrame
          geometry={geometry}
          screen={screen}
          room={fit}
          className={cn(
            "transition-opacity duration-(--motion-slow)",
            !props.live && !row.running && "opacity-40",
          )}
          overlay={
            <>
              <ActivityRipple shown={props.activity} screen={screen} />
              {props.highlight && <BoundsOutline bounds={props.highlight} screen={screen} />}
            </>
          }
        >
          {props.live && (
            <DeviceScreen
              session={props.session}
              deviceId={row.id}
              name={row.name}
              interactive={props.interactive}
              onInput={props.onInput}
              onFrame={(header) => {
                props.onFrame(header);
                const next = framePoints(header);
                setScreen((before) =>
                  before.width === next.width && before.height === next.height ? before : next,
                );
              }}
              className="h-full max-h-none w-full max-w-none rounded-none shadow-none"
            />
          )}
        </DeviceFrame>
      </div>
      {!props.live && props.idle && (
        <div className="absolute inset-0 grid place-items-center p-6">{props.idle}</div>
      )}
      {props.live && props.rail && (
        <div className="absolute top-1/2 right-3 -translate-y-1/2">{props.rail}</div>
      )}
      {props.footer && (
        <div className="pointer-events-none absolute inset-x-16 bottom-3 flex flex-col items-center gap-2 *:pointer-events-auto">
          {props.footer}
        </div>
      )}
    </div>
  );
}
