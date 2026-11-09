import { createRequire } from "node:module";
import type koffiModule from "koffi";

/**
 * koffi, for code that binds native libraries off Bun. The daemon runs on Bun and uses bun:ffi
 * instead; its releases ship no koffi. The desktop app's main process runs on Electron's Node
 * and ships koffi in its own `node_modules`, outside app.asar (apps/desktop/scripts/koffi.ts).
 *
 * Required on first use, never imported, so bundles that never call it build without it and
 * importing this module loads nothing. Node resolves it from the file this code is bundled
 * into: main's chunks in app.asar, or a worker bundle in app.asar.unpacked; in a dev build, the
 * desktop package's own dependency.
 */
export function loadKoffi(): typeof koffiModule {
  return createRequire(import.meta.url)("koffi");
}
