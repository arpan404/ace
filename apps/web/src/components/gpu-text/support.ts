/*
 * What this browser can draw with, probed once per page. A probe's context is released at once:
 * browsers cap live WebGL contexts (about 16) and drop the oldest past that, which could be a
 * terminal's or a diff's.
 */

let webgl2: boolean | undefined;

/** Whether WebGL2 is available (the GPU diff view, xterm's WebGL renderer). */
export function webgl2Available(): boolean {
  if (webgl2 !== undefined) return webgl2;
  webgl2 = false;
  if (typeof document === "undefined") return webgl2;
  try {
    const context = document.createElement("canvas").getContext?.("webgl2");
    webgl2 = !!context;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

let checked: Promise<{ webgpu: boolean; webgl2: boolean }> | undefined;
/** What this browser can draw text with. WebGPU needs an adapter, not just the API. */
export function textRendererSupport(): Promise<{ webgpu: boolean; webgl2: boolean }> {
  checked ??= (async () => {
    let webgpu = false;
    try {
      webgpu = typeof navigator !== "undefined" && !!(await navigator.gpu?.requestAdapter());
    } catch {
      webgpu = false;
    }
    return { webgpu, webgl2: webgl2Available() };
  })();
  return checked;
}
