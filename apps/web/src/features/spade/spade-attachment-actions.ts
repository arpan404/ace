import type { SpadeDocumentRef } from "@ace/ui-core/spade-chat";
import { createContext, useContext } from "react";

/**
 * What a chat attachment can ask the window to do beyond its own Download: show a document in
 * the side panel's reader, or find it in the bot's Library. Absent where there is no panel (the
 * action is then not offered).
 */
export interface SpadeAttachmentActions {
  openDocument?(document: SpadeDocumentRef): void;
  showInLibrary?(document: SpadeDocumentRef): void;
}

export const SpadeAttachmentActionsContext = createContext<SpadeAttachmentActions>({});

export const useAttachmentActions = () => useContext(SpadeAttachmentActionsContext);
