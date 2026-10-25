import type { SkillEntry, SkillUpdateReview, WorkspaceId } from "@ace/protocol";
import { useEffect, useRef, useState } from "react";
import { DiffBody } from "@/components/markdown/diff-body.tsx";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { sourceLine, updateDiff } from "./library-model.ts";
import {
  SkillRequestError,
  useApplySkillUpdate,
  useCancelSkillUpdate,
  useCheckSkillUpdate,
  usePrepareSkillUpdate,
} from "./library-source.ts";
import { skillTitle } from "./skills-model.ts";

/**
 * Source, for a skill installed from a repository: where it came from and when it was updated,
 * a check for a newer version, and a review of that version before anything changes.
 */
export function SkillSourceRow(props: { entry: SkillEntry; workspaceId: WorkspaceId | undefined }) {
  const { entry } = props;
  const now = useNow();
  const toast = useToast();
  const check = useCheckSkillUpdate();
  const prepare = usePrepareSkillUpdate();
  const [review, setReview] = useState<SkillUpdateReview>();
  const target = { id: entry.id, workspaceId: props.workspaceId };
  // A check answers for the folder it looked at; an update or edit since asks again.
  const status = check.data?.id === entry.id ? check.data.status : undefined;
  const checkedHash = useRef(entry.hash);
  useEffect(() => {
    if (checkedHash.current === entry.hash) return;
    checkedHash.current = entry.hash;
    check.reset();
  }, [entry.hash, check]);
  if (!entry.source) return null;
  const failed = (title: string) => (error: Error) =>
    toast.error({
      title,
      description:
        error instanceof SkillRequestError
          ? error.message
          : "Check your connection and try again.",
    });
  return (
    <>
      <SettingRow
        inline
        title="Source"
        description={
          <span>
            {sourceLine(entry.source, now)}
            {status === "available" && (
              <span className="font-medium text-foreground"> · Update available</span>
            )}
            {status === "current" && " · Up to date"}
          </span>
        }
      >
        {status === "available" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={prepare.isPending}
            onClick={() =>
              prepare.mutate(target, {
                onSuccess: setReview,
                onError: failed("Couldn't fetch the update"),
              })
            }
          >
            {prepare.isPending ? "Fetching…" : "Review update"}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate(target, { onError: failed("Couldn't check for updates") })}
          >
            {check.isPending ? "Checking…" : "Check for update"}
          </Button>
        )}
      </SettingRow>
      <UpdateReviewDialog
        entry={entry}
        workspaceId={props.workspaceId}
        review={review}
        onDone={(applied) => {
          setReview(undefined);
          if (applied) check.reset();
        }}
      />
    </>
  );
}

const changeWords = { added: "Added", changed: "Changed", removed: "Removed" } as const;

/** What the update changes, file by file, and SKILL.md line by line; Update applies it. */
function UpdateReviewDialog(props: {
  entry: SkillEntry;
  workspaceId: WorkspaceId | undefined;
  review: SkillUpdateReview | undefined;
  onDone(applied: boolean): void;
}) {
  const toast = useToast();
  const apply = useApplySkillUpdate();
  const cancel = useCancelSkillUpdate();
  const [error, setError] = useState<string>();
  // The last review stays written while the dialog fades out.
  const [shown, setShown] = useState(props.review);
  if (props.review && props.review !== shown) setShown(props.review);
  const review = props.review ?? shown;
  const title = skillTitle(props.entry);
  const close = () => {
    if (apply.isPending) return;
    if (props.review) cancel.mutate(props.review.id);
    setError(undefined);
    props.onDone(false);
  };
  return (
    <Dialog open={props.review !== undefined} onOpenChange={(open) => !open && close()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Update {title}</DialogTitle>
          <DialogDescription>
            {props.entry.source?.source}
            {review && ` · ${review.files.length === 1 ? "1 file" : `${review.files.length} files`} changed`}
          </DialogDescription>
        </DialogHeader>
        {review && (
          <DialogBody>
            <section aria-label="Files">
              <h3 className="mb-1 text-ui font-medium text-muted-foreground">Files</h3>
              <ul className="flex flex-col">
                {review.files.map((file) => (
                  <li key={file.path} className="flex items-baseline gap-3 py-1 text-ui">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                    {file.flagged && (
                      <span className="shrink-0 font-medium text-foreground">Agents may run it</span>
                    )}
                    <span className="w-16 shrink-0 text-right text-muted-foreground">
                      {changeWords[file.change]}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-label="SKILL.md">
              <h3 className="mb-1 text-ui font-medium text-muted-foreground">SKILL.md</h3>
              <div className="rounded-lg bg-(--code)">
                <DiffBody diff={updateDiff(review.before, review.after)} />
              </div>
            </section>
          </DialogBody>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={apply.isPending || !review}
            onClick={() => {
              if (!review) return;
              setError(undefined);
              apply.mutate(
                {
                  id: props.entry.id,
                  workspaceId: props.workspaceId,
                  reviewId: review.id,
                  expectedHash: props.entry.hash,
                },
                {
                  onSuccess: () => {
                    toast.success({ title: `Updated ${title}` });
                    props.onDone(true);
                  },
                  onError: (failure) =>
                    setError(
                      failure instanceof SkillRequestError
                        ? `Couldn't update ${title}. ${failure.message}`
                        : `Couldn't update ${title}. Check your connection and try again.`,
                    ),
                },
              );
            }}
          >
            {apply.isPending ? "Updating…" : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
