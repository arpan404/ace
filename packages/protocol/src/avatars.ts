import { z } from "zod";
import { IconResult } from "./turn-steps.ts";

const requestId = z.string().min(1).max(256);

/**
 * People's GitHub avatars (pull request authors, reviewers, commenters), relayed by the daemon so
 * a client never loads them from GitHub itself. Each URL is one the forge reported; the daemon
 * reads only the user or app id from it and fetches that avatar from avatars.githubusercontent.com,
 * never another host, as a PNG of at most 64px. Bytes are read with `icons.read`.
 */
export const AvatarsResolveRequest = z.object({
  type: z.literal("avatars.resolve"),
  requestId,
  urls: z.array(z.string().max(2048)).min(1).max(32),
});
export type AvatarsResolveRequest = z.infer<typeof AvatarsResolveRequest>;
export const AvatarsResolveResponse = z.object({
  type: z.literal("avatars.resolve"),
  requestId,
  /** One per requested URL, in order; `none` for a URL that names no GitHub avatar. */
  icons: z.array(IconResult).max(32),
});
export type AvatarsResolveResponse = z.infer<typeof AvatarsResolveResponse>;
