import { useState, type RefObject } from "react";
import { useHandheld } from "@/lib/breakpoints.ts";
import type { BrowserPageView, ForwardedInput } from "../sources.ts";
import { pageToScreen, relativeTo, type PageBox, type ScreenBox } from "./page-geometry.ts";
import { PageKeyboard } from "./page-keyboard.tsx";
import { PagePicker } from "./page-picker.tsx";

/**
 * What a live page shows outside its pixels, drawn over the frame: the page's `title` tooltip,
 * ace's picker for a select, date or colour input the page opened, and the hidden field that
 * types into the page's focused field. Mounted inside the pane, over the frame's picture.
 */
export function PageStateLayer(props: {
  page: BrowserPageView | undefined;
  pane: RefObject<HTMLElement | null>;
  picture: RefObject<HTMLElement | null>;
  frame: { width: number; height: number };
  forward(input: ForwardedInput): void;
}) {
  const { page, pane, picture, frame } = props;
  const sheet = useHandheld();
  const [answered, setAnswered] = useState<string>();
  /** The picker the person opened: shown until answered, wherever focus goes meanwhile. */
  const [opened, setOpened] = useState<string>();
  /** A page box's place on screen, through the picture's rendered box. */
  const onScreen = (box: PageBox): ScreenBox | undefined => {
    const drawn = picture.current?.getBoundingClientRect();
    return drawn ? pageToScreen(box, drawn, frame) : undefined;
  };
  const inPane = (box: PageBox): ScreenBox | undefined => {
    const screen = onScreen(box);
    const origin = pane.current?.getBoundingClientRect();
    return screen && origin ? relativeTo(screen, origin) : undefined;
  };
  const picker = page?.picker;
  // Only a picker opened while the person works in the pane: an agent's click opens none here.
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (
    picker &&
    picker.pickerId !== opened &&
    active instanceof Node &&
    pane.current?.contains(active)
  )
    setOpened(picker.pickerId);
  const shown = picker && opened === picker.pickerId && answered !== picker.pickerId;
  // A tooltip sits below the pointer, as a browser places it.
  const pointer = page?.tooltip;
  const tip =
    !shown && pointer ? inPane({ x: pointer.x, y: pointer.y, width: 0, height: 0 }) : undefined;
  return (
    <>
      <PageKeyboard focus={page?.focus} place={inPane} forward={props.forward} pane={pane} />
      {tip && pointer && (
        <div
          role="tooltip"
          className="ace-floating-solid pointer-events-none absolute max-w-80 rounded-sm px-2 py-1 text-xs break-words text-popover-foreground"
          style={{ left: Math.max(4, tip.left), top: tip.top + 20 }}
        >
          {pointer.text}
        </div>
      )}
      {shown && (
        <PagePicker
          key={picker.pickerId}
          picker={picker}
          sheet={sheet}
          returnFocus={pane}
          anchor={() => {
            const box = onScreen(picker.rect);
            return box && new DOMRect(box.left, box.top, box.width, box.height);
          }}
          onPick={(values) => {
            setAnswered(picker.pickerId);
            props.forward({
              kind: "pick",
              pickerId: picker.pickerId,
              ...(values ? { values } : {}),
            });
          }}
        />
      )}
    </>
  );
}
