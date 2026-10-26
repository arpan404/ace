import type { DeviceChrome, DeviceChromeButton } from "@ace/protocol";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import {
  chromeButtonEdge,
  chromeButtonKey,
  chromeButtonLabel,
  plateBox,
  turnedImage,
  type ChromeLayout,
  type DeviceKind,
  type Turn,
} from "@ace/ui-core/devices";
import {
  PressableHardware,
  pushIn,
  SideButtons,
  type Hardware,
  type HardwarePress,
} from "./hardware-buttons.tsx";

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

function ChromeButton(props: {
  button: DeviceChromeButton;
  chrome: DeviceChrome;
  layout: ChromeLayout;
  kind: DeviceKind;
  turn: Turn;
  press?: HardwarePress | undefined;
}) {
  const { button, layout } = props;
  const box = plateBox(button.rect, layout.scale);
  const art = `url("${button.image}")`;
  const style = {
    left: px(box.left),
    top: px(box.top),
    width: px(box.width),
    height: px(box.height),
    backgroundImage: art,
    backgroundSize: "100% 100%",
    backgroundRepeat: "no-repeat",
    "--art-pressed": button.pressed ? `url("${button.pressed}")` : art,
  } as CSSProperties;
  const key = chromeButtonKey(button);
  if (!key || !props.press)
    return <span aria-hidden className="pointer-events-none absolute" style={style} />;
  // The tooltip opens on the side it stands out from once turned; it is pushed from there.
  const side = chromeButtonEdge(button, props.chrome.body, props.turn);
  const upright = chromeButtonEdge(button, props.chrome.body, 0);
  return (
    <PressableHardware
      label={chromeButtonLabel(button, props.kind)}
      hardwareKey={key}
      side={side}
      press={props.press}
      className="pointer-events-auto"
      live={`active:[background-image:var(--art-pressed)] ${pushIn[upright]}`}
      style={style}
    />
  );
}

/**
 * A device drawn with its real hardware look from the SDK (Xcode's chrome, the emulator skin):
 * the body and its buttons as the SDK draws them, the live screen clipped to the screen's exact
 * shape, and a notch over it where the hardware has one. The body is drawn upright and turned
 * with CSS; the screen stays unturned so input lands where the picture is. `children` fill the
 * screen; `overlay` sits over them in the same box.
 */
export function ChromeFrame(props: {
  chrome: DeviceChrome;
  layout: ChromeLayout;
  kind: DeviceKind;
  turn: Turn;
  /** Absent, the buttons are drawn only (a thumbnail). */
  press?: HardwarePress | undefined;
  /** ace's own side buttons, drawn around the body when the SDK draws none (an emulator skin). */
  hardware?: Hardware | undefined;
  children?: ReactNode;
  overlay?: ReactNode;
  className?: string;
}) {
  const { chrome, layout, turn } = props;
  const { plate, screen } = layout;
  const plateStyle: CSSProperties = {
    left: px(plate.left),
    top: px(plate.top),
    width: px(plate.width),
    height: px(plate.height),
    transform: turn ? `rotate(${turn}deg)` : undefined,
  };
  const mask = chrome.mask ? `url("${turnedImage(chrome.mask, chrome.screen, turn)}")` : undefined;
  const buttons = (onTop: boolean) =>
    chrome.buttons
      .filter((button) => button.onTop === onTop)
      .map((button) => (
        <ChromeButton
          key={button.name}
          button={button}
          chrome={chrome}
          layout={layout}
          kind={props.kind}
          turn={turn}
          press={props.press}
        />
      ));
  const cutout = chrome.cutout && plateBox(chrome.cutout.rect, layout.scale);
  return (
    <div
      data-device-frame=""
      data-device-chrome=""
      className={cn("relative shrink-0", props.className)}
      style={{ width: px(layout.box.width), height: px(layout.box.height) }}
    >
      <div className="absolute" style={plateStyle}>
        {buttons(false)}
        <img
          alt=""
          aria-hidden
          draggable={false}
          src={chrome.body.image}
          className="pointer-events-none absolute inset-0 size-full select-none"
        />
      </div>
      <div
        data-device-screen=""
        className="absolute overflow-hidden bg-(--device-glass)"
        style={{
          left: px(screen.left),
          top: px(screen.top),
          width: px(screen.width),
          height: px(screen.height),
          maskImage: mask,
          maskSize: "100% 100%",
          maskRepeat: "no-repeat",
        }}
      >
        {props.children}
        {props.overlay}
      </div>
      <div className="pointer-events-none absolute" style={plateStyle}>
        {cutout && chrome.cutout && (
          <img
            alt=""
            aria-hidden
            draggable={false}
            src={chrome.cutout.image}
            className="absolute select-none"
            style={{
              left: px(cutout.left),
              top: px(cutout.top),
              width: px(cutout.width),
              height: px(cutout.height),
            }}
          />
        )}
        {buttons(true)}
      </div>
      {chrome.buttons.length === 0 && props.hardware && (
        <SideButtons
          hardware={props.hardware}
          body={layout.box}
          unit={Math.min(layout.screen.width, layout.screen.height)}
        />
      )}
    </div>
  );
}
