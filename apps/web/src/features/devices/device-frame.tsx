import {
  DeviceMobileCameraIcon,
  DeviceMobileIcon,
  DeviceTabletCameraIcon,
  DeviceTabletIcon,
  GogglesIcon,
  TelevisionSimpleIcon,
  WatchIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";
import { type DeviceKind, fitFrame, type FrameGeometry, type Size } from "@ace/ui-core/devices";
import { HomeButton, SideButtons, type Hardware } from "./hardware-buttons.tsx";

/** One glyph per kind of device, so a list of them reads at a glance. */
export const deviceGlyphs: Record<DeviceKind, IconGlyph> = {
  iphone: DeviceMobileIcon,
  ipad: DeviceTabletIcon,
  watch: WatchIcon,
  tv: TelevisionSimpleIcon,
  vision: GogglesIcon,
  "android-phone": DeviceMobileCameraIcon,
  "android-tablet": DeviceTabletCameraIcon,
};

/** The same geometry with no hardware: the screen alone, its corners barely rounded. */
export const bareGeometry: FrameGeometry = {
  bezel: { top: 0, right: 0, bottom: 0, left: 0 },
  screenRadius: 0.02,
  bodyRadius: 0.02,
  cutout: { kind: "none" },
  homeButton: false,
};

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

/** The bezel the home button sits in once the body has turned. */
const homeBezel = { 0: "bottom", 90: "left", 180: "top", 270: "right" } as const;

/**
 * A device drawn around its screen, sized to fit `room`: a graphite body with a lit rim, the
 * screen's black glass, its cutout, and `hardware`: the buttons on its sides and an older
 * iPhone's home button, pressable when `hardware.press` says how. Drawn with boxes only;
 * `children` (the live screen) fill the screen and are clipped to its corners, and `overlay`
 * sits over them in the same box.
 */
export function DeviceFrame(props: {
  geometry: FrameGeometry;
  /** The screen's size in points: only its aspect and the one-point-per-pixel cap matter. */
  screen: Size;
  room: Size;
  hardware?: Hardware | undefined;
  children?: ReactNode;
  overlay?: ReactNode;
  className?: string;
}) {
  const { geometry } = props;
  const fit = fitFrame(props.room, geometry, props.screen);
  const { unit } = fit;
  const { bezel, cutout } = geometry;
  if (unit <= 0) return null;
  return (
    <div
      data-device-frame=""
      className={cn("relative shrink-0", props.className)}
      style={{ width: px(fit.body.width), height: px(fit.body.height) }}
    >
      <span
        aria-hidden
        className="absolute inset-0 bg-(--device-body) shadow-(--device-rim)"
        style={{ borderRadius: px(geometry.bodyRadius * unit) }}
      />
      {props.hardware && <SideButtons hardware={props.hardware} body={fit.body} unit={unit} />}
      <div
        data-device-screen=""
        className="absolute overflow-hidden bg-(--device-glass)"
        style={{
          left: px(bezel.left * unit),
          top: px(bezel.top * unit),
          width: px(fit.screen.width),
          height: px(fit.screen.height),
          borderRadius: px(geometry.screenRadius * unit),
        }}
      >
        {props.children}
        {cutout.kind === "island" && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-(--device-glass)"
            style={{
              top: px(cutout.top * unit),
              width: px(cutout.width * unit),
              height: px(cutout.height * unit),
            }}
          />
        )}
        {cutout.kind === "notch" && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 bg-(--device-glass)"
            style={{
              width: px(cutout.width * unit),
              height: px(cutout.height * unit),
              borderBottomLeftRadius: px(cutout.height * unit * 0.6),
              borderBottomRightRadius: px(cutout.height * unit * 0.6),
            }}
          />
        )}
        {cutout.kind === "punch" && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-(--device-glass)"
            style={{
              top: px(cutout.top * unit),
              width: px(cutout.size * unit),
              height: px(cutout.size * unit),
            }}
          />
        )}
        {props.overlay}
      </div>
      {geometry.homeButton && props.hardware && (
        <HomeButton
          hardware={props.hardware}
          body={fit.body}
          bezel={bezel[homeBezel[props.hardware.turn]] * unit}
        />
      )}
    </div>
  );
}
