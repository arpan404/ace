import type { PluginInstall } from "@ace/protocol/plugins";
import type { PluginManifest } from "./manifest.ts";

export interface PackageFile {
  path: string;
  bytes: number;
  executable: boolean;
  hash: string;
}
export interface PluginSnapshot {
  install: PluginInstall;
  manifest: PluginManifest;
  root: string;
  files: PackageFile[];
  text: Record<string, string>;
  unsupported: string[];
}
export interface ImportedPlugin {
  manifest: PluginManifest;
  unsupported: string[];
  metadata: unknown;
  inlineFiles: Record<string, string>;
}
export type Provider = "claude" | "codex" | "opencode" | "cursor" | "antigravity" | "acp";
export interface ProjectedFile {
  path: string;
  executable: boolean;
  content?: string;
  source?: { path: string; hash: string };
}
export interface PluginProjection {
  env: Record<string, string>;
  args: string[];
  files: ProjectedFile[];
  sessionConfig: { mcpServers?: Record<string, unknown>[] };
  unsupported: string[];
}
