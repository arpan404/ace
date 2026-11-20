import { cleanPath, folderKey, pathParts } from "@ace/ui-core";
import { useEffect, useRef, useState } from "react";
import { useEditor } from "./file-tree-editor.ts";
import type { RevealTarget } from "./file-tree-follow.ts";
import { checkoutError } from "./checkout-source.ts";
import { useCheckoutSource } from "./use-checkout.ts";
import { useFileMutations } from "./use-file-mutations.ts";

/** The part of a name a rename selects: before the last dot, unless the dot starts it. */
export function nameStem(name: string, folder: boolean): number {
  if (folder) return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** The entry being renamed in the tree, and what its field may do. */
export interface InlineRename {
  /** The row key of the entry being renamed ("a/b/" for a folder), if any. */
  key: string | undefined;
  start(path: string, folder: boolean): void;
  /** Rename to `name` in the same folder: resolves what went wrong, or undefined once done. */
  commit(name: string): Promise<string | undefined>;
  cancel(): void;
}

/**
 * Rename in the row (workbench spec 34): the entry's folder stays, the name changes. Once the
 * daemon has it, open editors of the entry (or inside a renamed folder) follow it through the
 * Editor, and the tree reveals and selects the new entry.
 */
export function useInlineRename(
  threadId: string,
  reveal: (target: RevealTarget) => void,
): InlineRename {
  const [entry, setEntry] = useState<{ path: string; folder: boolean }>();
  const mutations = useFileMutations(threadId);
  const source = useCheckoutSource();
  const editor = useEditor(threadId);
  return {
    key: entry ? (entry.folder ? folderKey(entry.path) : entry.path) : undefined,
    start: (path, folder) => setEntry({ path: cleanPath(path), folder }),
    cancel: () => setEntry(undefined),
    commit: async (typed) => {
      if (!entry) return undefined;
      const name = typed.trim();
      const { name: before, folder } = pathParts(entry.path);
      if (!name || name === before) {
        setEntry(undefined);
        return undefined;
      }
      if (name.includes("/")) return "A name can't hold a slash. Use Move to change folders.";
      const to = folder ? `${folder}/${name}` : name;
      try {
        if ((await source.stat(threadId, to)).version !== null)
          return `${name} already exists here. Choose another name.`;
        await mutations.run({
          op: "rename",
          path: entry.path,
          expected: await mutations.versionOf(entry.path),
          destination: to,
          destinationExpected: null,
        });
      } catch (failure) {
        return checkoutError(failure).message;
      }
      setEntry(undefined);
      editor.renamed({ from: entry.path, to, folder: entry.folder });
      reveal({ path: to, folder: entry.folder, focus: true });
      return undefined;
    },
  };
}

/**
 * The name field a row turns into while it is renamed: Enter renames, Escape or leaving it keeps
 * the name. What stopped a rename shows under the field.
 */
export function RenameField(props: {
  name: string;
  folder: boolean;
  onCommit(name: string): Promise<string | undefined>;
  /** `keyboard`: Escape gave it up, so the keyboard goes back to the row. */
  onCancel(keyboard: boolean): void;
}) {
  const [value, setValue] = useState(props.name);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    // A menu hands focus back to its opener before the field takes it.
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(0, nameStem(props.name, props.folder));
    });
    return () => cancelAnimationFrame(frame);
  }, [props.name, props.folder]);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const failed = await props.onCommit(value);
    setBusy(false);
    setError(failed);
  };
  return (
    <span data-inline-rename className="flex min-w-0 flex-1 flex-col py-0.5">
      <input
        ref={input}
        aria-label={`Rename ${props.name}`}
        aria-invalid={error ? true : undefined}
        value={value}
        spellCheck={false}
        autoComplete="off"
        readOnly={busy}
        onChange={(event) => {
          setValue(event.target.value);
          setError(undefined);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (composing.current || event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel(true);
          }
        }}
        onBlur={() => {
          if (!busy) props.onCancel(false);
        }}
        className="h-6 w-full min-w-0 rounded-sm bg-background px-1.5 text-ui text-foreground shadow-[inset_0_0_0_1px_var(--ring)] outline-none aria-invalid:shadow-[inset_0_0_0_1px_var(--status-failed)]"
      />
      {error && (
        <span role="alert" className="pt-1 text-xs leading-4 whitespace-normal text-status-failed">
          {error}
        </span>
      )}
    </span>
  );
}
