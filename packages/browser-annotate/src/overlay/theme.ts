import type { OverlayPalette, OverlayTokens } from "./types.ts";

/** Stylesheet for the closed shadow root, adopted through CSSOM (CSP-safe, no <style>). */
export function overlaySheet(tokens: OverlayTokens): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  const { radii, motion } = tokens;
  sheet.replaceSync(`
*, *::before, *::after { box-sizing: border-box; }
.layer {
  position: fixed; inset: 0; pointer-events: none; color: var(--text);
  font: 500 13px/18px ${tokens.font}; letter-spacing: 0; text-align: left;
  -webkit-font-smoothing: antialiased; direction: ltr; cursor: default;
}
.outline {
  position: fixed; left: 0; top: 0; display: none; pointer-events: none;
  border: 2px solid var(--mark); border-radius: 3px; background: var(--wash);
}
.outline.shown { display: block; }
.marker {
  position: fixed; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px;
  display: grid; place-items: center; border-radius: 50%; pointer-events: auto; cursor: pointer;
  background: var(--mark); color: var(--on-mark); user-select: none;
  font: 650 11px/1 ${tokens.font}; font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px var(--ring), 0 2px 8px var(--shadow);
  transition: transform ${motion.fast}ms ${motion.enter};
  animation: pop ${motion.standard}ms ${motion.enter};
}
.marker:hover { transform: scale(1.08); }
.marker.pending { cursor: default; }
.marker.lost { display: none; }
.markers.hidden .marker:not(.pending) { display: none; }
.glass {
  background: var(--glass); border: 1px solid var(--edge);
  -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6);
  box-shadow: 0 10px 30px var(--shadow), 0 1px 3px var(--shadow);
}
.editor {
  position: fixed; left: 0; top: 0; width: 320px; pointer-events: auto;
  display: flex; flex-direction: column; gap: 4px; padding: 4px 4px 4px 6px;
  border-radius: ${radii.pill}px; animation: enter ${motion.standard}ms ${motion.enter};
}
.editor.editing { border-radius: ${radii.card}px; padding: 6px 8px 8px 6px; }
.row { display: flex; align-items: flex-start; gap: 4px; }
.actions { display: flex; align-items: center; gap: 6px; }
.spacer { flex: 1; }
textarea {
  flex: 1; min-width: 0; height: 28px; max-height: 112px; margin: 0; padding: 5px 2px;
  border: 0; outline: 0; resize: none; overflow-y: auto; background: transparent;
  color: var(--text); caret-color: var(--accent); font: 400 13px/18px ${tokens.font};
}
textarea::placeholder { color: var(--muted); opacity: 1; }
button {
  all: unset; box-sizing: border-box; cursor: pointer; flex: none;
  transition: background ${motion.fast}ms, color ${motion.fast}ms, opacity ${motion.fast}ms;
}
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button:disabled { opacity: 0.38; cursor: default; }
.icon { display: block; flex: none; }
.icon-button {
  width: 28px; height: 28px; display: inline-grid; place-items: center;
  border-radius: ${radii.small}px; color: var(--muted);
}
.icon-button:not(:disabled):hover { background: var(--hover); color: var(--text); }
.icon-button.on { color: var(--accent); }
.icon-button.danger:not(:disabled):hover { color: var(--danger); }
.submit {
  width: 28px; height: 28px; display: inline-grid; place-items: center; border-radius: 50%;
  background: var(--accent); color: var(--on-accent);
}
.pill {
  height: 28px; padding: 0 12px; border-radius: ${radii.pill}px;
  font: 500 13px/28px ${tokens.font}; white-space: nowrap;
}
.pill.ghost { color: var(--text); box-shadow: inset 0 0 0 1px var(--edge); }
.pill.ghost:hover { background: var(--hover); }
.pill.primary { background: var(--accent); color: var(--on-accent); }
.pill.primary:not(:disabled):hover { filter: brightness(1.08); }
.bar {
  position: fixed; left: 0; top: 0; height: 42px; padding: 0 5px 0 3px;
  display: flex; align-items: center; gap: 2px; pointer-events: auto; user-select: none;
  white-space: nowrap; border-radius: ${radii.pill}px;
  animation: enter ${motion.standard}ms ${motion.enter};
}
.handle {
  width: 22px; height: 32px; display: grid; place-items: center; color: var(--muted);
  cursor: grab; touch-action: none; border-radius: ${radii.small}px;
}
.handle:active { cursor: grabbing; }
.label { padding: 0 8px 0 2px; color: var(--text); font-variant-numeric: tabular-nums; }
.divider { width: 1px; height: 18px; margin: 0 4px; background: var(--edge); }
.bar .pill.primary { margin-left: 4px; height: 30px; line-height: 30px; padding: 0 14px; }
.toast {
  position: fixed; left: 0; top: 0; height: 34px; padding: 0 14px; display: flex;
  align-items: center; border-radius: ${radii.pill}px; pointer-events: none;
  font: 500 13px/1 ${tokens.font}; animation: enter ${motion.standard}ms ${motion.enter};
}
.concealed { visibility: hidden !important; }
.capturing * { animation: none !important; transition: none !important; }
[hidden] { display: none !important; }
@keyframes enter { from { opacity: 0; transform: translateY(4px); } }
@keyframes pop { from { opacity: 0; transform: scale(0.6); } }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`);
  return sheet;
}

/** Theme switches are variable writes on the layer, never a new sheet. */
export function applyPalette(layer: HTMLElement, palette: OverlayPalette): void {
  const variables: Record<string, string> = {
    "--accent": palette.accent,
    "--on-accent": palette.onAccent,
    "--mark": palette.mark,
    "--on-mark": palette.onMark,
    "--wash": palette.markWash,
    "--glass": palette.glass,
    "--edge": palette.edge,
    "--text": palette.text,
    "--muted": palette.muted,
    "--hover": palette.hover,
    "--danger": palette.danger,
    "--shadow": palette.shadow,
    "--ring": palette.ring,
  };
  for (const [name, value] of Object.entries(variables)) layer.style.setProperty(name, value);
}
