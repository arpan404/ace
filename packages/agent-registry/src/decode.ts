import { z } from "zod";
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
export const limits = Object.freeze({
  response: 4 * 1024 * 1024,
  entries: 2048,
  entry: 64 * 1024,
  installations: 512,
  ttl: 86400000,
});
const args = z.array(z.string().max(4096)).max(64).default([]);
const env = z
  .record(z.string().min(1).max(256), z.string().max(8192))
  .refine((value) => Object.keys(value).length <= 128)
  .default({});
export const PackageDistribution = z
  .object({ package: z.string().min(1).max(1024), args, env })
  .passthrough();
export const BinaryTarget = z
  .object({
    archive: z.url().max(4096),
    cmd: z.string().min(1).max(4096),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    args,
    env,
  })
  .passthrough();
const Distribution = z
  .object({
    npx: PackageDistribution.optional(),
    uvx: PackageDistribution.optional(),
    binary: z.record(z.string().max(128), BinaryTarget).optional(),
  })
  .passthrough()
  .refine((value) => Object.keys(value).length > 0);
export const AgentEntry = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(128),
    name: z.string().min(1).max(512),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .max(128),
    description: z.string().min(1).max(8192),
    distribution: Distribution,
    authors: z.array(z.string().max(256)).max(64).default([]),
    repository: z.url().max(4096).optional(),
    website: z.url().max(4096).optional(),
    license: z.string().max(256).optional(),
    license_url: z.url().max(4096).optional(),
    icon: z.string().max(4096).optional(),
  })
  .passthrough()
  .refine((value) => value.id === "dimcode" || value.license_url !== undefined);
export type AgentEntry = z.infer<typeof AgentEntry>;
export const RegistryIndex = z
  .object({
    version: z.string().regex(/^1\.\d+\.\d+$/),
    agents: z.array(AgentEntry).max(limits.entries),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const agent of value.agents) {
      if (seen.has(agent.id) || Buffer.byteLength(JSON.stringify(agent)) > limits.entry)
        ctx.addIssue({ code: "custom", message: "Duplicate or oversized registry entry" });
      seen.add(agent.id);
    }
  });
export type RegistryIndex = z.infer<typeof RegistryIndex>;
export function decodeIndex(bytes: Uint8Array): RegistryIndex {
  if (bytes.byteLength > limits.response) throw new Error("Registry exceeds response limit");
  return RegistryIndex.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
export function platformTarget(platform: string, arch: string): string | undefined {
  const os = platform === "win32" ? "windows" : platform;
  if (!["darwin", "linux", "windows"].includes(os)) return undefined;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  return cpu ? `${os}-${cpu}` : undefined;
}
export function availability(
  agent: AgentEntry,
  target: string,
): "available" | "unsupported_distribution" | "unsupported_target" {
  if (agent.distribution.npx || agent.distribution.uvx || agent.distribution.binary?.[target])
    return "available";
  return agent.distribution.binary ? "unsupported_target" : "unsupported_distribution";
}
