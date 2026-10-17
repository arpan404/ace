import { button, clamp, h, place } from "./dom.ts";
import { icon } from "./icons.ts";

export interface BarCallbacks {
  screenshot(): void;
  markers(hidden: boolean): void;
  discard(): void;
  send(): void;
  close(): void;
  moved(x: number, y: number): void;
  /** Phase 3: show the page without live style edits while held. Absent, the button is disabled. */
  original?: { hold(): void; release(): void };
}

/** The floating, draggable control bar: count, screenshot, markers, original, discard, Send, exit. */
export function createBar(parent: HTMLElement, callbacks: BarCallbacks) {
  const handle = h("div", { class: "handle", attrs: { "aria-label": "Move bar", title: "Move" } }, [
    icon("grip"),
  ]);
  const label = h("span", { class: "label", text: "Annotating" });
  let hidden = false;
  const eye = button("icon-button", "Hide markers", [icon("eye")], () => setHidden(!hidden));
  function setHidden(value: boolean): void {
    hidden = value;
    eye.replaceChildren(icon(hidden ? "eyeOff" : "eye"));
    eye.classList.toggle("on", hidden);
    const text = hidden ? "Show markers" : "Hide markers";
    eye.setAttribute("aria-label", text);
    eye.title = text;
    callbacks.markers(hidden);
  }
  const original = button("icon-button", "Hold to view original", [icon("compare")], () => {});
  original.disabled = !callbacks.original;
  if (callbacks.original) {
    const { hold, release } = callbacks.original;
    original.addEventListener("pointerdown", (event) => {
      if (event.isTrusted && !original.disabled) hold();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave"] as const)
      original.addEventListener(type, () => release());
  }
  const discard = button("icon-button danger", "Discard annotations", [icon("trash")], () =>
    callbacks.discard(),
  );
  const send = button("pill primary", "Send", [], () => callbacks.send());
  send.textContent = "Send";
  const root = h(
    "div",
    { class: "bar glass", attrs: { role: "toolbar", "aria-label": "Annotate" } },
    [
      handle,
      label,
      h("div", { class: "divider" }),
      button("icon-button", "Take a screenshot", [icon("screenshot")], () =>
        callbacks.screenshot(),
      ),
      eye,
      original,
      discard,
      send,
      button("icon-button", "Exit annotate mode", [icon("close")], () => callbacks.close()),
    ],
  );
  parent.append(root);
  let custom: { x: number; y: number } | undefined;
  let drag: { pointer: number; dx: number; dy: number } | undefined;

  function layout(): void {
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    const x = custom ? custom.x : (innerWidth - width) / 2;
    const y = custom ? custom.y : innerHeight - height - 16;
    const left = clamp(x, 8, innerWidth - width - 8);
    const top = clamp(y, 8, innerHeight - height - 8);
    place(root, { translate: `${left}px ${top}px` });
  }
  handle.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    const box = root.getBoundingClientRect();
    drag = { pointer: event.pointerId, dx: event.clientX - box.left, dy: event.clientY - box.top };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    custom = { x: event.clientX - drag.dx, y: event.clientY - drag.dy };
    layout();
  });
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = undefined;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    const box = root.getBoundingClientRect();
    callbacks.moved(Math.round(box.left), Math.round(box.top));
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  addEventListener("resize", layout);
  layout();
  return {
    count(total: number): void {
      label.textContent = total ? `Annotating · ${total}` : "Annotating";
      discard.disabled = total === 0;
      send.disabled = total === 0;
      layout();
    },
    markersHidden(value: boolean): void {
      if (value !== hidden) setHidden(value);
    },
    moveTo(point: { x: number; y: number } | undefined): void {
      custom = point;
      layout();
    },
    conceal(value: boolean): void {
      root.classList.toggle("concealed", value);
    },
    /** The bar's top edge, so a toast can sit just above it. */
    top(): number {
      return root.getBoundingClientRect().top;
    },
    centre(): number {
      const box = root.getBoundingClientRect();
      return box.left + box.width / 2;
    },
    dispose(): void {
      removeEventListener("resize", layout);
      root.remove();
    },
  };
}
export type Bar = ReturnType<typeof createBar>;
