import type { DesktopSettings, SpadeTalkPhase, SpadeTalkState } from "../shared/contract.ts";

/*
 * Push to talk to the main Spade from anywhere (ADR 0134, amended). Electron's global shortcuts
 * report a press and never its release, on every platform, so the shortcut is press to talk: the
 * first press listens, the page sends once the person stops talking, and a second press sends at
 * once. The page says how the turn goes; the indicator shows it in words. Pure: the main process
 * owns the shortcut and the window.
 */

/** The chord used when the person never chose one: ⌥Space on macOS only, where it is free. */
export function defaultTalkShortcut(platform: NodeJS.Platform): string | null {
  return platform === "darwin" ? "Alt+Space" : null;
}

/** The push-to-talk chord these settings ask for; null: off. */
export function talkShortcutOf(
  settings: DesktopSettings,
  platform: NodeJS.Platform,
): string | null {
  return settings.spadeTalkShortcut === undefined
    ? defaultTalkShortcut(platform)
    : settings.spadeTalkShortcut;
}

/**
 * What a press means, given how the turn goes: listen when nothing is going on, or over Spade
 * thinking or speaking (it stops and listens again); send while the person is being heard.
 */
export function talkPress(state: SpadeTalkState): SpadeTalkPhase {
  return state === "listening" || state === "hearing" || state === "transcribing"
    ? "send"
    : "start";
}

/** The indicator's words for a state; undefined: no indicator. */
export function talkIndicatorWords(state: SpadeTalkState): string | undefined {
  switch (state) {
    case "off":
      return undefined;
    case "listening":
      return "Listening · sends when you stop";
    case "hearing":
      return "Hearing you";
    case "transcribing":
      return "Turning it into words";
    case "thinking":
      return "Spade is thinking";
    case "speaking":
      return "Spade is speaking";
  }
}

/** The indicator's page: one quiet line and Cancel, in the system's own font and scheme. */
export function talkIndicatorPage(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
:root{color-scheme:light dark}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;user-select:none}
body{display:flex;align-items:center;justify-content:center;font:13px/1.2 system-ui,-apple-system,sans-serif}
div{display:flex;gap:10px;align-items:center;padding:8px 8px 8px 16px;border-radius:999px;
background:Canvas;color:CanvasText;box-shadow:0 0 0 1px color-mix(in srgb,CanvasText 14%,transparent),0 6px 24px rgb(0 0 0/.18)}
a{color:color-mix(in srgb,CanvasText 70%,transparent);text-decoration:none;padding:4px 10px;border-radius:999px}
a:hover{background:color-mix(in srgb,CanvasText 8%,transparent);color:CanvasText}
</style></head><body><div><span id="words" role="status"></span><a href="ace-talk:cancel">Cancel</a></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** The Cancel link's address, caught before it navigates anywhere. */
export const talkCancelUrl = "ace-talk:cancel";
