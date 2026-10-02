import { z } from "zod";
export const ReleaseTarget = z.enum(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
export const ReleaseVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/)
  .max(80);
export const ReleaseManifest = z.object({
  version: ReleaseVersion,
  channel: z.enum(["stable", "preview"]),
  target: ReleaseTarget,
  archive: z
    .string()
    .regex(/^ace-[a-z0-9.-]+\.tar\.gz$/)
    .max(160),
  bytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;
export const MaintenanceStatus = z.object({
  draining: z.boolean(),
  blockers: z.number().int().nonnegative(),
});
export const DaemonHealth = z.object({ running: z.literal(true), version: z.string() });

export const InstalledRelease = ReleaseManifest.pick({
  version: true,
  channel: true,
  target: true,
});

export const ReleaseDirectory = z.templateLiteral([
  "releases/",
  ReleaseVersion,
  "-",
  ReleaseTarget,
]);

export type ReleaseDirectory = z.infer<typeof ReleaseDirectory>;
