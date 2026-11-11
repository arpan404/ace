import { linkAttachmentMarkers, type ComposerDraft, type MarkerFile } from "@ace/ui-core";

/**
 * A draft from storage or another window, its file markers tied to this composer's chips by
 * each file's hash; a marker whose file isn't here goes. Pure.
 */
export function linkMarkers(draft: ComposerDraft, files: readonly MarkerFile[]): ComposerDraft {
  if (!draft.tokens?.some((token) => token.attachment)) return draft;
  const linked = linkAttachmentMarkers(draft.text, draft.tokens, files);
  return { ...draft, text: linked.text, tokens: linked.tokens };
}
