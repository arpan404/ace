import { z } from "zod";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserBackendSession } from "./backend.ts";

const ScreenshotBytes = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength <= 8 * 1024 * 1024, "Browser screenshot exceeds image limit");
/** A screenshot's bytes are released only while its submitted read/control fences still hold. */
export async function agentScreenshot(
  backend: BrowserBackendSession,
  syncTab: () => Promise<void>,
  fences: {
    read(): void;
    input(): void;
    ready(): void;
    generation(): number;
    lost(): boolean;
    paused(): boolean;
  },
  signal?: AbortSignal,
  tabId?: string,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  fences.read();
  fences.ready();
  if (tabId) {
    fences.input();
    await backend.tabs?.switch(tabId);
  }
  await syncTab();
  fences.read();
  if (tabId) fences.input();
  const generation = fences.generation();
  const bytes = await backend.screenshot("jpeg");
  signal?.throwIfAborted();
  fences.read();
  if (fences.paused()) throw new BrowserActionError("backend_changed");
  fences.ready();
  if (generation !== fences.generation() && fences.lost())
    throw new BrowserActionError("backend_changed");
  return ScreenshotBytes.parse(bytes);
}
