import type { AttachmentReader, ComposerDraft } from "@ace/ui-core";
import type { ReactNode, Ref } from "react";
import type { ThreadRef } from "../sources/index.ts";
import type { Draft } from "./draft.ts";
import type { ReturnedDraft } from "./send-store.ts";
import type { SubmittedDraft } from "./submitted-draft.ts";

/** What other parts of the thread screen may ask of its composer. */
export interface ComposerHandle {
  /** Keep the current draft for the thread that replaces this provisional view. */
  preserveDraft(key: string): void;
  /** A recovered send clears its matching draft and leaves any newer message alone. */
  discardIfSubmitted(sent: SubmittedDraft): boolean;
  /** Open the + menu (files, images, a mention, a page) over the composer. */
  openAdd(): void;
  /** Put the caret in the message. */
  focus(): void;
  /** Attach what a drop or paste elsewhere on the screen carries; call it during the event. */
  takeFiles(data: DataTransfer): void;
  /** Send the message as Send would (the Browser's annotate bar asks for it). */
  submit(): void;
}

export interface ComposerProps {
  thread: ThreadRef;
  /** Where this device keeps the unsent draft; without one it lives only while mounted. */
  draftKey?: string | undefined;
  /** A starting message when this draft has no saved text. */
  initialText?: string | undefined;
  /** Uploaded files outlive a reload only where the daemon keeps them: an existing thread. */
  keepsAttachments?: boolean | undefined;
  /** The agent is busy: an empty draft shows Stop; a draft shows its follow-up action. */
  busy: boolean;
  /** What Enter does with a follow-up while busy; ⌘↵ does the other. Defaults to queue. */
  followUp?: "queue" | "steer" | undefined;
  /** ⌘↵ does the other follow-up; false when the provider can't steer (both queue). */
  canSteer?: boolean | undefined;
  /**
   * Take the message. Resolves false when this device couldn't save it: the composer puts it
   * back if nothing new was typed meanwhile.
   */
  onSubmit(draft: Draft): Promise<boolean>;
  /** The last message sent here, for ↑ in an empty composer while the agent is idle. */
  recall?: (() => string | undefined) | undefined;
  /** Observe preparation content without duplicating the composer storage format. */
  onDraftChange?: ((draft: ComposerDraft) => void) | undefined;
  /** A preparation owner fences writes when another editor has claimed its durable row. */
  ownsDraft?: (() => boolean) | undefined;
  /** A file selection owns a preparation even before its upload finishes. */
  onFilesAdded?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
  /** Esc in a busy composer that can stop, at the key's time; Esc does nothing without it. */
  onStopKey?: ((at: number) => void) | undefined;
  /** A Stop is on its way: the button says so until the turn ends. */
  stopping?: boolean | undefined;
  /** Edit on a failed message brought back the effort and speed it was sent with. */
  onReturnedOptions?: ((options: ReturnedDraft["options"]) => void) | undefined;
  /** Footer controls after +: the approvals icon. They read `useComposerCompact()`. */
  controls?: ReactNode;
  /** Model and effort controls beside Stop and send on the main action row. */
  trailing?: ReactNode;
  /**
   * The tab attached to the composer (what the agents are doing, their plan, an
   * agent's question): drawn above it, narrower and tucked behind its top edge. It reads
   * `useComposerCompact()` too.
   */
  attached?: ReactNode;
  /**
   * Where the thread runs (New thread's machine, worktree and base): attached above the box when
   * nothing else is, sharing its compact-width context. Nothing renders below the composer.
   */
  environment?: ReactNode;
  /**
   * Provider/model information for the surrounding composer controls. Attachments always
   * have a daemon file-path fallback, including when native media input is unavailable.
   */
  reader?: AttachmentReader | undefined;
  /** Send may go while files upload: the message waits in the strip until they're done. */
  sendsWhileUploading?: boolean | undefined;
  placeholder?: string | undefined;
  /** The placeholder on a narrow composer, where `placeholder` would be cut short. */
  shortPlaceholder?: string | undefined;
  autoFocus?: boolean | undefined;
  /** Printable keys typed on the page (not in a field, menu or dialog) write here. */
  typeToFocus?: boolean | undefined;
  /** The input's accessible name; "Message" by default. */
  label?: string | undefined;
  /**
   * Why nothing can be sent here at all (a side chat the daemon can't run): the composer keeps
   * its shape, but its input and actions are off and point at the reason.
   */
  unavailable?:
    | {
        reason: string;
        describedBy: string;
        /** The reason in a few words, shown as the placeholder ("Side chats need a newer daemon"). */
        short?: string | undefined;
      }
    | undefined;
  /** Keep drafting and attachment controls available while only sending is blocked. */
  sendBlocked?: { reason: string; describedBy: string } | undefined;
  onPlan?: (() => void) | undefined;
  ref?: Ref<ComposerHandle> | undefined;
}
