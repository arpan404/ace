/*
 * The editor's buffers (docs/editor/workbench.md 46–58): one shared buffer per file, drafts on the
 * device, saving through the versioned write, and the three-way merge when the disk moves under
 * unsaved edits.
 */
export { attribute, attributionWindow, type Author, type EditCall } from "./attribution.ts";
export {
  checkoutFiles,
  type CheckoutAccess,
  type CheckoutRead,
  type CheckoutWrite,
} from "./checkout-files.ts";
export { deviceDrafts } from "./device-drafts.ts";
export { workerMerge } from "./merge-port.ts";
export {
  createBufferRegistry,
  defaultCapBytes,
  defaultDraftDelay,
  type BufferRegistry,
  type BufferRegistryOptions,
} from "./registry.ts";
export type * from "./types.ts";
