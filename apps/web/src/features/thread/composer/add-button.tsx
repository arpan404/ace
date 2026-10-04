import { PlusIcon } from "@phosphor-icons/react";
import { Suspense, useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { ThreadRef } from "../sources/index.ts";
import { iconControl } from "./composer-styles.ts";
import { DeferredAddMenu, MenuPending } from "./deferred-menus.tsx";

/** Why each way of adding is unavailable right now; undefined when it is available. */
export interface AddReasons {
  files?: string | undefined;
  images?: string | undefined;
  mention?: string | undefined;
  command?: string | undefined;
}

/**
 * The + at the start of the composer's footer. It opens the Add menu above the composer (files,
 * images, a file mention, a command, recent files) rather than a bare file dialog; focus returns
 * to the message afterwards.
 */
export function AddButton(props: {
  reasons: AddReasons;
  /** Files mentioned lately in this project, read when the menu opens. */
  recent(): readonly string[];
  focusTarget: RefObject<HTMLTextAreaElement | null>;
  onFiles(files: FileList): void;
  onMention(): void;
  onCommand(): void;
  onRecent(path: string): void;
  /** Puts text in the message at the caret (a page's address). */
  onInsert(text: string): void;
  /** The thread the composer writes in, for its own rows; none on New thread. */
  thread?: ThreadRef | undefined;
  /** The composer's width: the menu spans its writing width (8px in from each side). */
  width: number;
  /** Opens the menu from elsewhere (the summary's Sources +). */
  handle?: Ref<{ open(): void }> | undefined;
}) {
  const files = useRef<HTMLInputElement>(null);
  const images = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    if (next) setRecent(props.recent());
    setOpen(next);
  };
  useImperativeHandle(props.handle, () => ({ open: () => change(true) }));
  const picked = (event: { target: HTMLInputElement }) => {
    if (event.target.files?.length) props.onFiles(event.target.files);
    event.target.value = "";
  };
  return (
    <>
      <Menu open={open} onOpenChange={change}>
        <Tip label="Add files and context" side="top">
          <MenuTrigger aria-label="Add files and context" className={iconControl}>
            <PlusIcon aria-hidden size={16} />
          </MenuTrigger>
        </Tip>
        <MenuContent
          side="top"
          align="start"
          style={{ width: Math.max(260, props.width - 16) }}
          finalFocus={props.focusTarget}
        >
          <Suspense fallback={<MenuPending />}>
            <DeferredAddMenu.Component
              files={{ reason: props.reasons.files }}
              images={{ reason: props.reasons.images }}
              mention={{ reason: props.reasons.mention }}
              command={{ reason: props.reasons.command }}
              recent={recent}
              onFiles={() => files.current?.click()}
              onImages={() => images.current?.click()}
              onMention={props.onMention}
              onCommand={props.onCommand}
              onRecent={props.onRecent}
              thread={props.thread}
              onInsert={props.onInsert}
            />
          </Suspense>
        </MenuContent>
      </Menu>
      <input
        ref={files}
        type="file"
        multiple
        hidden
        aria-label="Files to attach"
        onChange={picked}
      />
      <input
        ref={images}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Images to attach"
        onChange={picked}
      />
    </>
  );
}
