export { ContextError } from "./errors.ts";
export { portableContext, type PortableSource } from "./handoff.ts";
export {
  GitWorkspace,
  type WorkspaceFiles,
  type WorkspaceFileEntry,
  type WorkspaceFolderLister,
} from "./git-workspace.ts";
export { resolveMentions, defaultMentionLimits, type MentionLimits } from "./mentions.ts";
export { sniffMime, inspectImage, defaultImageLimits, type ImageLimits } from "./media.ts";
export {
  UploadStore,
  defaultUploadLimits,
  type UploadOptions,
  type UploadLimits,
} from "./upload-store.ts";
export { ContextService, type ContextServiceOptions } from "./service.ts";
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

export { deliverContext, type ContextDelivery, type ContextConsumer } from "./delivery.ts";

export { summarizeThreadReference } from "./thread-reference.ts";
export { canonicalContext } from "./canonical.ts";
export { markPlaces, fillPlaces, type Places } from "./placement.ts";
export { encodedContextBudget } from "./encoded-budget.ts";
export { contextNotice } from "./notice.ts";
