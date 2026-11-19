import { MagnifyingGlassIcon, XIcon } from "@ace/icons";
import { useRef } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { FileMenu } from "./file-menu.tsx";
import type { FileOperationDialog } from "./file-operation.ts";

/** The tree's filter and its file menu; the field owns Enter (open the first file) and ↓. */
export function FileTreeSearch(props: {
  query: string;
  onQuery(query: string): void;
  /** A search is on its way. */
  pending: boolean;
  /** The current file's folder, without a trailing slash ("" at the root). */
  folder: string;
  disabled: boolean;
  onOperation(operation: FileOperationDialog): void;
  onUpload(files: readonly File[], folder: string): void;
  onFirstRow(): void;
  onEnter(): void;
}) {
  const upload = useRef<HTMLInputElement>(null);
  const folder = props.folder ? `${props.folder}/` : "";
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 px-2">
      <label className="relative flex h-8 min-w-0 flex-1 items-center rounded-md bg-foreground/5 shadow-[inset_0_0_0_1px_var(--border)] transition-shadow duration-(--motion-fast) focus-within:shadow-[inset_0_0_0_1px_var(--ring)]">
        <MagnifyingGlassIcon
          aria-hidden
          size={14}
          className="ml-2.5 shrink-0 text-subtle-foreground"
        />
        <input
          type="search"
          aria-label="Find files in the checkout"
          placeholder="Find files…"
          value={props.query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => props.onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && props.query) {
              event.preventDefault();
              event.stopPropagation();
              props.onQuery("");
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              props.onFirstRow();
            } else if (event.key === "Enter") {
              props.onEnter();
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent pr-1 pl-2 text-ui text-foreground outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        {props.pending && <Spinner className="mr-1.5" />}
        {props.query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => props.onQuery("")}
            className="mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-subtle-foreground outline-none hover:bg-accent hover:text-foreground focus-ring"
          >
            <XIcon aria-hidden size={12} />
          </button>
        )}
      </label>
      <FileMenu
        folder={props.folder}
        disabled={props.disabled}
        onOperation={props.onOperation}
        onUpload={() => upload.current?.click()}
      />
      <input
        ref={upload}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) props.onUpload(files, folder);
        }}
      />
    </div>
  );
}
