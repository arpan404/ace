import { useId, useState } from "react";

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ThreadRenameDialogContent
          key={initialTitle}
          description={description}
          initialTitle={initialTitle}
          title={title}
          onOpenChange={onOpenChange}
          onSubmit={onSubmit}
        />
      ) : null}
    </Dialog>
  );
}

function ThreadRenameDialogContent({
  description,
  initialTitle,
  title,
  onOpenChange,
  onSubmit,
}: Omit<ThreadRenameDialogProps, "open">) {
  const formId = useId();
  const inputId = useId();
  const [draftTitle, setDraftTitle] = useState(initialTitle);
  const [submitting, setSubmitting] = useState(false);
  const trimmedTitle = draftTitle.trim();

  const submitRename = async () => {
    if (submitting || trimmedTitle.length === 0) {
      return;
    }
    setSubmitting(true);
    const shouldClose = await Promise.resolve(onSubmit(trimmedTitle)).catch((error: unknown) => {
      setSubmitting(false);
      throw error;
    });
    setSubmitting(false);
    if (shouldClose) {
      onOpenChange(false);
    }
  };

  return (
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
          <label htmlFor={inputId} className="block space-y-1.5">
            <span className="text-[13px] font-medium text-foreground/78">Chat title</span>
            <Input
              id={inputId}
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
  );
}
