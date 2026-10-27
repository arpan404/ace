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
  band: 0,
  homeButton: false,
};

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

/** The bezel the home button sits in once the body has turned. */
const homeBezel = { 0: "bottom", 90: "left", 180: "top", 270: "right" } as const;

/**
 * A device drawn around its screen, sized to fit `room`: a thin metal band lit from above, one
 * even ring of black glass inside it, the screen with the model's own corner radius (the body's
 * corners concentric with it), and `hardware`: the buttons on its sides and an older
 * iPhone's home button, pressable when `hardware.press` says how. Drawn with boxes only;
 * `children` (the live screen) fill the screen and are clipped to its corners, and `overlay`
 * sits over them in the same box. Nothing is painted over the picture: the device's own pixels
 * already show its island, notch or camera.
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
  const { bezel } = geometry;
  const band = geometry.band * unit;
  if (unit <= 0) return null;
  return (
    <div
      data-device-frame=""
      className={cn("relative shrink-0", props.className)}
      style={{ width: px(fit.body.width), height: px(fit.body.height) }}
    >
      <span
        aria-hidden
        className="absolute inset-0 bg-(--device-body) bg-(image:--device-metal) shadow-(--device-rim)"
        style={{ borderRadius: px(geometry.bodyRadius * unit) }}
      />
      {band > 0 && (
        // The black glass inside the metal band, concentric with the body.
        <span
          aria-hidden
          className="absolute bg-(--device-glass)"
          style={{
            inset: px(band),
            borderRadius: px(Math.max(0, geometry.bodyRadius * unit - band)),
          }}
        />
      )}
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
