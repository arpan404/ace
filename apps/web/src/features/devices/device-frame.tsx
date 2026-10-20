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
import type { DeviceKind } from "./device-catalog.ts";
import { fitFrame, type FrameGeometry, type Size } from "./device-frame-geometry.ts";

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
  crown: false,
};

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

/**
 * A device drawn around its screen, sized to fit `room`: a graphite body with a lit rim, the
 * screen's black glass, and the cutout, home button or crown its kind has. Drawn with boxes
 * only; `children` (the live screen) fill the screen and are clipped to its corners, and
 * `overlay` sits over them in the same box.
 */
export function DeviceFrame(props: {
  geometry: FrameGeometry;
  /** The screen's size in points: only its aspect and the one-point-per-pixel cap matter. */
  screen: Size;
  room: Size;
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
      {geometry.crown && (
        <>
          <span
            aria-hidden
            className="absolute bg-(--device-body) shadow-(--device-rim)"
            style={{
              left: "100%",
              top: px(fit.body.height * 0.26),
              width: px(unit * 0.045),
              height: px(unit * 0.2),
              borderRadius: px(unit * 0.02),
            }}
          />
          <span
            aria-hidden
            className="absolute bg-(--device-body) shadow-(--device-rim)"
            style={{
              left: "100%",
              top: px(fit.body.height * 0.56),
              width: px(unit * 0.025),
              height: px(unit * 0.26),
              borderRadius: px(unit * 0.012),
            }}
          />
        </>
      )}
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
      {geometry.homeButton && (
        <span
          aria-hidden
          className="absolute left-1/2 -translate-x-1/2 rounded-full shadow-(--device-rim)"
          style={{
            top: px(
              (bezel.top + props.screen.height / props.screen.width) * unit +
                bezel.bottom * unit * 0.25,
            ),
            width: px(bezel.bottom * unit * 0.5),
            height: px(bezel.bottom * unit * 0.5),
          }}
        />
      )}
    </div>
  );
}
