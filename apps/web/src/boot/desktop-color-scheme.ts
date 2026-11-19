/**
 * The OS light or dark mode for the theme's "System" mode in the Windows desktop app.
 *
 * On Windows the page's `prefers-color-scheme` does not follow the OS when it changes (nor on a
 * reload afterwards), while the desktop app's own view of it does and is sent over the bridge
 * (`theme.appearance`, `theme.changed`). There the dark-mode query is answered by the bridge;
 * every other query, and every other platform, uses the page's own `matchMedia` unchanged.
 */

const darkQuery = "(prefers-color-scheme: dark)";

type MatchMedia = (query: string) => MediaQueryList;
type Listener = (event: MediaQueryListEvent) => void;

interface ThemeBridge {
  appearance(): Promise<unknown>;
  onChange(listener: (value: unknown) => void): unknown;
}

export interface DesktopColorScheme {
  matchMedia: MatchMedia;
  /**
   * Windows: settles once the desktop has said light or dark (or after `waitMs`), so the first
   * render reads the OS's mode rather than the page's stale guess. Undefined elsewhere.
   */
  ready: Promise<void> | undefined;
}

export function desktopColorScheme(
  base: MatchMedia,
  scope: object = globalThis,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  waitMs = 1_500,
): DesktopColorScheme {
  const theme = windowsThemeBridge(scope);
  if (!theme) return { matchMedia: base, ready: undefined };
  let dark: boolean | undefined;
  const listeners = new Set<Listener>();
  const update = (value: unknown) => {
    const next = darkOf(value);
    if (next === undefined || next === dark) return;
    dark = next;
    const event = { matches: next, media: darkQuery } as MediaQueryListEvent;
    for (const listener of listeners) listener(event);
  };
  // Subscribed before asking, so a change in between is never missed.
  theme.onChange(update);
  const answered = theme.appearance().then(update, () => {});
  const matchMedia: MatchMedia = (query) => {
    const own = base(query);
    if (query !== darkQuery) return own;
    return {
      get matches() {
        return dark ?? own.matches;
      },
      media: darkQuery,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => void listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => void listeners.delete(listener),
      addListener: (listener: Listener) => void listeners.add(listener),
      removeListener: (listener: Listener) => void listeners.delete(listener),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
  return { matchMedia, ready: Promise.race([answered, wait(waitMs)]) };
}

/** The bridge's theme calls, only in the Windows desktop app. */
function windowsThemeBridge(scope: object): ThemeBridge | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (!ace || typeof ace !== "object" || Reflect.get(ace, "platform") !== "win32") return undefined;
  const theme: unknown = Reflect.get(ace, "theme");
  if (!theme || typeof theme !== "object") return undefined;
  const appearance: unknown = Reflect.get(theme, "appearance");
  const onChange: unknown = Reflect.get(theme, "onChange");
  if (typeof appearance !== "function" || typeof onChange !== "function") return undefined;
  return {
    appearance: () => Promise.resolve(appearance.call(theme)),
    onChange: (listener) => onChange.call(theme, listener),
  };
}

function darkOf(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const dark: unknown = Reflect.get(value, "dark");
  return typeof dark === "boolean" ? dark : undefined;
}
