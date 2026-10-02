export {
  PluginManifest,
  PluginPath,
  Marketplace,
  McpServer,
  limits,
  parseJson,
} from "./manifest.ts";
export { importPlugin, agentPluginSchema, agentMcpSchema } from "./import.ts";
export { PluginManager } from "./manager.ts";
export type { PluginManagerOptions } from "./manager.ts";
export { projectPlugins } from "./project.ts";
export { materializeProjection, removeProjection } from "./materialize.ts";
export { inspectPackage } from "./files.ts";
export type {
  PluginSnapshot,
  ImportedPlugin,
  PackageFile,
  Provider,
  ProjectedFile,
  PluginProjection,
} from "./types.ts";

export { PluginService } from "./service.ts";
