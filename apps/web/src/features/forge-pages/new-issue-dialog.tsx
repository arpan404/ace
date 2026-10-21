import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ForgeRepository } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { useIssueWrites } from "./issue-writes.ts";

/** A new issue on the project's repository: a title and a Markdown description. */
export function NewIssueDialog(props: {
  project: string;
  repository: ForgeRepository;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const writes = useIssueWrites(props.project, props.repository);
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = async () => {
    const issue = await writes.write({ action: "create", title: title.trim(), body });
    if (!issue) return;
    setTitle("");
    setBody("");
    props.onOpenChange(false);
    void navigate({
      to: "/issues/$project/$number",
      params: { project: props.project, number: String(issue.number) },
    });
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New issue in {props.repository.name}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <Input
            aria-label="Title"
            placeholder="Title"
            maxLength={256}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <Textarea
            aria-label="Description"
            placeholder="Description (Markdown)"
            maxLength={64_000}
            rows={8}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
        </DialogBody>
        <DialogFooter submitHint>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!title.trim() || !writes.ready || writes.pending}
            onClick={() => void create()}
          >
            Create issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
