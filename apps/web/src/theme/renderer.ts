import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";

/*
 * Whether this browser draws without graphics acceleration (a blocklisted driver, a VM, a remote
 * desktop). There, every backdrop blur is computed on the CPU each time anything under it
 * changes: a frosted composer over a streaming transcript holds each keystroke's frame for one
 * to two frames more. Such a device shows Translucency as Solid, like a system that reduces
 * transparency.
 */

/** Renderer names of CPU rasterizers across Chromium, Mesa, Windows and WebKit. */
const software =
  /swiftshader|llvmpipe|softpipe|lavapipe|basic render driver|software rasterizer|software adapter/i;

/** True for a CPU rasterizer, or no WebGL at all (graphics acceleration is off). */
export function isSoftwareRenderer(renderer: string | undefined): boolean {
  return renderer === undefined || software.test(renderer);
}

/** The WebGL renderer's name, or undefined where WebGL is unavailable. */
export function webglRenderer(document: Document): string | undefined {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return undefined;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const name: unknown = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

const cacheKey = "ace.software-rendering";

/**
 * Whether to treat this device as drawing in software. The last answer is kept, so a launch
 * never waits on a WebGL context; it is checked again when the page is idle (a driver update or
 * a different machine), for the next launch. Only a first launch reads the renderer at once.
 */
export function softwareRendering(options: {
  storage: KeyValueStorage | undefined;
  renderer: () => string | undefined;
  idle: (task: () => void) => unknown;
  /**
   * A browser under automation (`navigator.webdriver`): tests and screenshot tools run headless
   * on a CPU rasterizer and must see the design as chosen, so it is never forced Solid there.
   */
  automated: boolean;
}): boolean {
  if (options.automated) return false;
  const detect = () => {
    const found = isSoftwareRenderer(options.renderer());
    writeJson(options.storage, cacheKey, found);
    return found;
  };
  const cached = readJson(options.storage, cacheKey, z.optional(z.boolean()), undefined);
  if (cached === undefined) return detect();
  options.idle(detect);
  return cached;
}
