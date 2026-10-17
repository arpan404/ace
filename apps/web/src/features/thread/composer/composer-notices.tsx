import type { ComposerDraft } from "@ace/ui-core";

/** One-line notes above the composer: another window's version, what couldn't attach, storage. */
export function ComposerNotices(props: {
  theirs: ComposerDraft | undefined;
  onUseTheirs(draft: ComposerDraft): void;
  notice: string | undefined;
  saveFailed: boolean;
}) {
  const { theirs } = props;
  return (
    <>
      {theirs && (
        <p className="mb-1.5 px-2 text-xs text-subtle-foreground">
          Edited in another window ·{" "}
          <button
            type="button"
            className="rounded-sm font-medium text-muted-foreground underline-offset-4 focus-ring hover:text-foreground hover:underline"
            onClick={() => props.onUseTheirs(theirs)}
          >
            Use that version
          </button>
        </p>
      )}
      {props.notice && (
        <p role="status" className="mb-1.5 px-2 text-xs text-subtle-foreground">
          {props.notice}
        </p>
      )}
      {props.saveFailed && (
        <p role="status" className="mb-1.5 px-2 text-xs text-subtle-foreground">
          Draft not saved: storage full
        </p>
      )}
    </>
  );
}
