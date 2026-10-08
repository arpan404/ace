import { z } from "zod";

export const PreviewPort = z.number().int().min(1).max(65535);
const text = z.string().min(1).max(4096);
export const PreviewLaunch = z
  .object({
    name: z.string().min(1).max(128),
    command: text.optional(),
    runtimeExecutable: text.optional(),
    args: z.array(z.string().max(4096)).max(128).default([]),
    cwd: text.optional(),
    env: z.record(z.string().min(1).max(128), z.string().max(8192)).default({}),
    port: PreviewPort.optional(),
    autoPort: z.boolean().default(false),
    url: z.string().url().max(4096).optional(),
  })
  .superRefine((entry, ctx) => {
    const executables =
      Number(entry.command !== undefined) + Number(entry.runtimeExecutable !== undefined);
    if (entry.url ? executables !== 0 || entry.autoPort : executables !== 1) {
      ctx.addIssue({ code: "custom", message: "Choose one executable or an attach URL" });
    }
  })
  .meta({
    "x-ace-constraint":
      "Choose exactly one executable, or an attach URL without an executable or autoPort.",
    examples: [{ name: "example", command: "node" }],
  });
export type PreviewLaunch = z.infer<typeof PreviewLaunch>;
export const PreviewLaunchFile = z.object({ configurations: z.array(PreviewLaunch).max(64) });
export const PreviewControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("preview.list") }),
  z.object({ type: z.literal("preview.start"), name: text }),
  z.object({ type: z.literal("preview.stop"), name: text }),
  z.object({ type: z.literal("preview.forward"), port: PreviewPort }),
  z.object({ type: z.literal("preview.unforward"), port: PreviewPort }),
  z.object({ type: z.literal("preview.link"), port: PreviewPort }),
]);
export const PreviewDescriptor = z.object({
  port: PreviewPort,
  origin: z.string().url().optional(),
  name: text.optional(),
  source: z.enum(["listener", "terminal", "launch"]),
});

/** Why a preview gateway refused a navigation; its refusal page names one of these. */
export const PreviewRefusal = z.enum([
  /** The request carried no session cookie (never signed in, expired, or the browser dropped it). */
  "signed_out",
  /** A session cookie that no longer verifies: expired, revoked, or from before a daemon restart. */
  "session_expired",
  /** A sign-in link that expired, was already used, or was not issued by this gateway. */
  "link_invalid",
  /** No preview answers at this address any more (stopped previewing, or a daemon restart). */
  "not_previewed",
  /** The gateway is signed in but the dev server behind it didn't answer. */
  "upstream_unavailable",
]);
export type PreviewRefusal = z.infer<typeof PreviewRefusal>;
/**
 * What a gateway refusal page posts to the page framing it (`window.postMessage`), so the
 * embedder can say what went wrong across origins. Carries no credential.
 */
export const PreviewGatewayStatus = z.object({
  type: z.literal("ace-preview.status"),
  status: z.number().int().min(400).max(599),
  reason: PreviewRefusal,
});
export type PreviewGatewayStatus = z.infer<typeof PreviewGatewayStatus>;
