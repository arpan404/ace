import { CaretRightIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { DiffStat } from "@/components/diff-stat.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import type { ChangedFile } from "../sources/workspace-source.ts";

const letters: Record<ChangedFile["status"], { letter: string; label: string }> = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  untracked: { letter: "U", label: "Untracked" },
};

/** Start with the whole change selected; the person can leave individual files out. */
export const pickedByDefault = (files: readonly ChangedFile[]): ReadonlySet<string> =>
  new Set(files.map((file) => file.path));

/** The paths a commit of `picked` names: a rename's old path too, so its removal goes with it. */
export const pathsOf = (files: readonly ChangedFile[], picked: ReadonlySet<string>): string[] => [
  ...new Set(
    files
      .filter((file) => picked.has(file.path))
      .flatMap((file) => (file.from ? [file.path, file.from] : [file.path])),
  ),
];

/**
 * The files a commit takes, exactly as `git status` lists them, each with a checkbox: what is
 * ticked is what gets committed. Collapsible, so a long list doesn't push the message away.
 */
export function ChangedFiles(props: {
  files: readonly ChangedFile[] | undefined;
  truncated: boolean;
  /** The read failed: say so, with Try again. */
  failed: boolean;
  picked: ReadonlySet<string>;
  onPick(next: ReadonlySet<string>): void;
  onRetry(): void;
  onViewDiff(): void;
}) {
  const { files, picked } = props;
  const [open, setOpen] = useState(true);
  const ids = useId();
  if (props.failed)
    return (
      <div role="alert" className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">Couldn't list the files to commit.</span>
        <Button type="button" size="sm" variant="ghost" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    );
  if (!files)
    return (
      <div className="flex h-7 items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Listing the files…
      </div>
    );
  if (!files.length)
    return (
      <p className="text-sm text-muted-foreground">Nothing to commit: the checkout is clean.</p>
    );
  const count = `${files.length}${props.truncated ? "+" : ""} ${files.length === 1 ? "file" : "files"}`;
  const toggle = (path: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(path);
    else next.delete(path);
    props.onPick(next);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-7 items-center gap-2 text-sm">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="focus-ring -ml-1 flex h-7 items-center gap-1 rounded-sm px-1 font-medium text-foreground"
        >
          <CaretRightIcon
            aria-hidden
            size={12}
            className={cn("transition-transform duration-(--dur-1)", open && "rotate-90")}
          />
          {count}
        </button>
        <span className="text-muted-foreground">· {picked.size} picked</span>
        <button
          type="button"
          onClick={props.onViewDiff}
          className="focus-ring ml-auto rounded-sm px-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          View diff
        </button>
      </div>
      {open && (
        <ul
          aria-label="Files to commit"
          className="-mx-2 max-h-[196px] overflow-y-auto overscroll-contain"
        >
          {files.map((file, index) => {
            const { letter, label } = letters[file.status];
            const slash = file.path.lastIndexOf("/");
            return (
              <li
                key={file.path}
                className="flex h-7 min-w-0 items-center gap-2 rounded-sm px-2 hover:bg-accent"
              >
                <Checkbox
                  id={`${ids}-${index}`}
                  checked={picked.has(file.path)}
                  onCheckedChange={(checked) => toggle(file.path, checked)}
                />
                <abbr
                  title={label}
                  aria-label={label}
                  className="w-3 shrink-0 text-center font-mono text-xs text-muted-foreground no-underline"
                >
                  {letter}
                </abbr>
                {/* The path alone names the checkbox; clicking it ticks the box too. */}
                <label
                  htmlFor={`${ids}-${index}`}
                  className="min-w-0 flex-1 cursor-pointer truncate font-mono text-xs"
                  title={file.from ? `${file.from} → ${file.path}` : file.path}
                >
                  <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
                  {file.path.slice(slash + 1)}
                </label>
                <DiffStat additions={file.additions} deletions={file.deletions} />
              </li>
            );
          })}
        </ul>
      )}
      {props.truncated && (
        <p className="text-xs text-muted-foreground">
          Only the first {files.length} files are listed; the rest stay uncommitted.
        </p>
      )}
    </div>
  );
}
