/** What this browser can draw text with. Checked once; WebGPU needs an adapter, not just the API. */
let checked: Promise<{ webgpu: boolean; webgl2: boolean }> | undefined;
export function textRendererSupport(): Promise<{ webgpu: boolean; webgl2: boolean }> {
  checked ??= (async () => {
    const webgl2 =
      typeof document !== "undefined" && !!document.createElement("canvas").getContext?.("webgl2");
    let webgpu = false;
    try {
      webgpu = typeof navigator !== "undefined" && !!(await navigator.gpu?.requestAdapter());
    } catch {
      webgpu = false;
    }
    return { webgpu, webgl2 };
  })();
  return checked;
}
