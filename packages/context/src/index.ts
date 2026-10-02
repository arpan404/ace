export { ContextError } from "./errors.ts";
export { PathIndex } from "./path-index.ts";
export { GitWorkspace, type WorkspaceFiles } from "./git-workspace.ts";
export { resolveMentions, defaultMentionLimits, type MentionLimits } from "./mentions.ts";
export { sniffMime, inspectImage, defaultImageLimits, type ImageLimits } from "./media.ts";
export {
  UploadStore,
  defaultUploadLimits,
  type UploadOptions,
  type UploadLimits,
} from "./upload-store.ts";
export { ContextService, type ContextServiceOptions } from "./service.ts";
export { WorkspaceCache } from "./workspace-cache.ts";
export {
  projectAttachments,
  fileUri,
  PreparedAttachment,
  ProjectionCapabilities,
  type Projection,
  type ClaudeInput,
  type CodexInput,
  type OpenCodeInput,
  type AcpInput,
} from "./projection.ts";

export type { BlobLease } from "./blob-leases.ts";
