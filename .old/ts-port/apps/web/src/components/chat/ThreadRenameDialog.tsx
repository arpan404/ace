import { useEffect, useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

type ThreadRenameDialogProps = {
  readonly description?: string;
  readonly initialTitle: string;
  readonly open: boolean;
  readonly title?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (title: string) => boolean | Promise<boolean>;
};

export function ThreadRenameDialog({
  description = "Update the chat title.",
  initialTitle,
  open,
  title = "Rename chat",
  onOpenChange,
  onSubmit,
}: ThreadRenameDialogProps) {
  const formId = useId();
  const [draftTitle, setDraftTitle] = useState(initialTitle);
  const [submitting, setSubmitting] = useState(false);
  const trimmedTitle = draftTitle.trim();

  useEffect(() => {
    if (open) {
      setDraftTitle(initialTitle);
      setSubmitting(false);
    }
  }, [initialTitle, open]);

  const submitRename = async () => {
    if (submitting || trimmedTitle.length === 0) {
      return;
    }
    setSubmitting(true);
    try {
      const shouldClose = await onSubmit(trimmedTitle);
      if (shouldClose) {
        onOpenChange(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <label className="block space-y-1.5">
              <span className="text-[13px] font-medium text-foreground/78">Chat title</span>
              <Input
                value={draftTitle}
                autoFocus
                aria-label="Chat title"
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setDraftTitle(event.target.value)}
              />
            </label>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button form={formId} type="submit" disabled={submitting || trimmedTitle.length === 0}>
            {submitting ? "Renaming..." : "Rename"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
