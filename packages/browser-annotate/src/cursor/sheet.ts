import type { CursorInit } from "../cursor-init.ts";

/** The cursor layer's stylesheet, adopted into its closed shadow root (CSP-safe). */
export function cursorSheet(init: CursorInit): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  const { motion } = init;
  sheet.replaceSync(`
*, *::before, *::after { box-sizing: border-box; }
.layer {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  font: 600 11px/16px ${init.font}; letter-spacing: 0; direction: ltr;
  -webkit-font-smoothing: antialiased;
  transition: opacity ${motion.standard}ms ${motion.enter};
}
.layer.person { opacity: 0; }
.layer.capture { visibility: hidden; transition: none; }
.agent {
  position: absolute; left: 0; top: 0; will-change: transform;
  transition: transform var(--glide) ${motion.enter}, opacity ${motion.standard}ms ${motion.enter};
}
.agent.leaving { opacity: 0; }
.pebble { position: absolute; display: block; overflow: visible;
  filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.28)) drop-shadow(0 0 0.5px rgba(0, 0, 0, 0.2)); }
.name {
  position: absolute; left: 14px; top: 18px; max-width: 160px; padding: 0 6px;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border-radius: 999px;
  background: var(--fill); color: var(--outline); box-shadow: 0 0 0 1px var(--outline), 0 1px 3px rgba(0, 0, 0, 0.25);
}
.pulse {
  position: absolute; left: 0; top: 0; width: 28px; height: 28px; margin: -14px 0 0 -14px;
  border-radius: 50%; border: 2px solid var(--fill); box-shadow: 0 0 0 1px var(--outline);
}
.field {
  position: absolute; left: 0; top: 0; border-radius: 6px;
  box-shadow: 0 0 0 2px var(--fill), 0 0 0 3px var(--outline), 0 0 14px 2px var(--fill);
  transition: opacity ${motion.standard}ms ${motion.enter};
}
.field::after {
  content: ""; position: absolute; right: 8px; top: 25%; bottom: 25%; width: 2px;
  border-radius: 1px; background: var(--fill);
}
.scroll {
  position: absolute; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px;
  display: grid; place-items: center; border-radius: 50%;
  background: var(--fill); color: var(--outline); box-shadow: 0 0 0 1.5px var(--outline);
}
.trail { position: absolute; left: 0; top: 0; overflow: visible; }
@media (prefers-reduced-motion: reduce) {
  .agent { transition: opacity ${motion.standard}ms ${motion.enter}; }
}
`);
  return sheet;
}

/** Masks secret fields in the page itself: their text and bullets render transparent. */
export function maskSheet(
  selector: string,
  Sheet: typeof CSSStyleSheet = CSSStyleSheet,
): CSSStyleSheet {
  const sheet = new Sheet();
  sheet.replaceSync(`${selector} {
  color: transparent !important; -webkit-text-fill-color: transparent !important;
  -webkit-text-security: disc !important; text-shadow: none !important;
  caret-color: transparent !important;
}`);
  return sheet;
}
