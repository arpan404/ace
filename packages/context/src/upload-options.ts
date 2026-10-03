import type { FileHandle } from "node:fs/promises";
import type { ImageLimits } from "./media.ts";

export interface UploadLimits {
  fileBytes: number;
  threadBytes: number;
  globalBytes: number;
  threadEntries: number;
  globalEntries: number;
  uploads: number;
  queued: number;
  ttlMs: number;
}
export const defaultUploadLimits: UploadLimits = {
  fileBytes: 32 * 1024 * 1024,
  threadBytes: 128 * 1024 * 1024,
  globalBytes: 2 * 1024 * 1024 * 1024,
  threadEntries: 256,
  globalEntries: 65_536,
  uploads: 1024,
  queued: 32,
  ttlMs: 24 * 60 * 60 * 1000,
};
export interface UploadOptions {
  signal?: AbortSignal;
  root: string;
  now(): number;
  id(): string;
  authorize(device: string, thread: string): boolean | Promise<boolean>;
  workspace?(id: string): string | undefined | Promise<string | undefined>;
  threadWorkspace?(id: string): string | undefined | Promise<string | undefined>;
  /** Synchronous durable ownership check, immediately before reference removal. */
  retained?(thread: string, hash: string): boolean;
  limits?: Partial<UploadLimits>;
  imageLimits?: ImageLimits;
  /** Trusted storage boundary; resolves only once chunk bytes are durable. */
  syncChunk?: (file: FileHandle) => Promise<void>;
}
