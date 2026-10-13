/*
 * The desktop app's chat visualization surface, through its preload bridge (`window.ace`). There
 * a visualization renders in a `<webview>` whose session refuses every request, and "Open in
 * window" opens the same locked session. In a browser there is no bridge and this is undefined.
 */

export interface DesktopVisualizations {
  /** Opens a visualization's sandboxed `data:` document in its own window. */
  open(request: { title: string; url: string }): Promise<void>;
}

function member(owner: unknown, key: string): unknown {
  return typeof owner === "object" && owner !== null ? Reflect.get(owner, key) : undefined;
}

export function desktopVisualizations(
  scope: object = globalThis,
): DesktopVisualizations | undefined {
  const open = member(member(Reflect.get(scope, "ace"), "visualizations"), "open");
  if (typeof open !== "function") return undefined;
  return {
    async open(request) {
      await open(request);
    },
  };
}
