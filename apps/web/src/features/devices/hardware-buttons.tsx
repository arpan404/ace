import { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { CSSProperties } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import type { Edge, HardwareButton, HardwareKey, Turn, Size } from "@ace/ui-core/devices";

/** Pressing the drawn hardware: whether a press reaches the device now, and where it goes. */
export interface HardwarePress {
  /** You control the device and it is live. */
  enabled: boolean;
  /** Why a press does nothing now, when the person could fix that. */
  reason?: string | undefined;
  onPress(key: HardwareKey): void;
}

/** The hardware drawn on a device's body. */
export interface Hardware {
  buttons: readonly HardwareButton[];
  /** How far the body is turned, which says which bezel the home button is in. */
  turn: Turn;
  /** Absent, everything is drawn only (a thumbnail inside another control). */
  press?: HardwarePress | undefined;
}

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

/** A button pushed in moves toward the body: away from the edge it stands on. */
export const pushIn: Record<Edge, string> = {
  right: "active:-translate-x-px",
  left: "active:translate-x-px",
  top: "active:translate-y-px",
  bottom: "active:-translate-y-px",
};

/**
 * One piece of hardware the person can press: a real button named for the hardware, with its
 * name as a tooltip on the side it stands out from. While a press can't reach the device it
 * stays focusable when there's a reason to show, and its tooltip says why.
 */
export function PressableHardware(props: {
  label: string;
  hardwareKey: HardwareKey;
  /** The side its tooltip opens on: the one it stands out from. */
  side: Edge;
  press: HardwarePress;
  /** Its shape and fill at rest. */
  className: string;
  /** How it answers the pointer while a press reaches the device: hover and push. */
  live: string;
  style: CSSProperties;
}) {
  const { press } = props;
  const disabled = !press.enabled;
  return (
    <Tip label={disabled && press.reason ? press.reason : props.label} side={props.side}>
      <ButtonPrimitive
        aria-label={props.label}
        disabled={disabled}
        focusableWhenDisabled={press.reason !== undefined}
        onClick={() => press.onPress(props.hardwareKey)}
        className={cn(
          // An invisible margin around a sliver of metal, so it can be hit.
          "absolute transition-[background-color,transform] duration-(--motion-fast) ease-smooth focus-ring before:absolute before:-inset-1.5 before:content-['']",
          props.className,
          !disabled && props.live,
        )}
        style={props.style}
      />
    </Tip>
  );
}

/** Where a side button sits against the body, in pixels. */
function sideStyle(button: HardwareButton, body: Size, unit: number): CSSProperties {
  const depth = button.depth * unit;
  const radius = px(depth * 0.45);
  if (button.edge === "left" || button.edge === "right")
    return {
      [button.edge === "right" ? "left" : "right"]: "100%",
      top: px(button.start * body.height),
      height: px(button.length * body.height),
      width: px(depth),
      borderRadius: radius,
    };
  return {
    [button.edge === "top" ? "bottom" : "top"]: "100%",
    left: px(button.start * body.width),
    width: px(button.length * body.width),
    height: px(depth),
    borderRadius: radius,
  };
}

/**
 * The buttons on the body's sides, standing out from it. What ace can press is a button; the
 * rest (a ring switch, or every button on a thumbnail) is drawn only.
 */
export function SideButtons(props: { hardware: Hardware; body: Size; unit: number }) {
  const { press } = props.hardware;
  return props.hardware.buttons.map((button) => {
    const style = sideStyle(button, props.body, props.unit);
    return button.key && press ? (
      <PressableHardware
        key={button.label}
        label={button.label}
        hardwareKey={button.key}
        side={button.edge}
        press={press}
        className="bg-(--device-body) shadow-(--device-rim)"
        live={`hover:bg-(--device-body-hover) ${pushIn[button.edge]}`}
        style={style}
      />
    ) : (
      <span
        key={button.label}
        aria-hidden
        className="absolute bg-(--device-body) shadow-(--device-rim)"
        style={style}
      />
    );
  });
}

/** The bezel the device's bottom faces once its body has turned. */
const bottomAfter: Record<Turn, Edge> = { 0: "bottom", 90: "left", 180: "top", 270: "right" };

/**
 * An older iPhone's round home button, centred in the bezel below the screen, wherever the
 * turn has put that bezel.
 */
export function HomeButton(props: {
  hardware: Hardware;
  body: Size;
  /** The depth of the bezel it sits in, in pixels. */
  bezel: number;
}) {
  const edge = bottomAfter[props.hardware.turn];
  const size = props.bezel * 0.5;
  const style: CSSProperties = {
    ...(edge === "bottom" || edge === "top"
      ? { left: px(props.body.width / 2 - size / 2) }
      : { top: px(props.body.height / 2 - size / 2) }),
    [edge]: px(props.bezel / 2 - size / 2),
    width: px(size),
    height: px(size),
  };
  const { press } = props.hardware;
  if (!press)
    return (
      <span aria-hidden className="absolute rounded-full shadow-(--device-rim)" style={style} />
    );
  return (
    <PressableHardware
      label="Home button"
      hardwareKey="home"
      side={edge}
      press={press}
      className="rounded-full shadow-(--device-rim)"
      live="hover:bg-(--device-body-hover) active:scale-[0.94]"
      style={style}
    />
  );
}
