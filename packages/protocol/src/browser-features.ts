import { z } from "zod";
const id = z.string().min(1).max(256);
export const BrowserDialog = z.object({
  dialogId: id,
  tabId: id,
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string().max(4096),
  defaultPrompt: z.string().max(4096).optional(),
});
export type BrowserDialog = z.infer<typeof BrowserDialog>;
export const BrowserTab = z.object({
  tabId: id,
  url: z.string().max(8192),
  title: z.string().max(1024),
  pending_dialog: BrowserDialog.optional(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;
export const BrowserDownload = z.object({
  downloadId: id,
  tabId: id,
  filename: z.string().max(256),
  bytes: z.number().int().nonnegative(),
  mimeType: z.string().max(256),
  flags: z.array(z.enum(["executable", "archive"])),
  state: z.enum(["pending", "complete", "denied", "failed", "too_large"]),
  path: z.string().optional(),
});
export type BrowserDownload = z.infer<typeof BrowserDownload>;
export const BrowserEvaluateGrant = z.object({
  origin: z.string().max(8192),
  mode: z.literal("read-only"),
  grantedAt: z.number().finite(),
});
export type BrowserEvaluateGrant = z.infer<typeof BrowserEvaluateGrant>;
