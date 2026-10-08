import { useClient, useThread, useThreadMeta } from "@ace/client-react";
import { ItemId, ThreadId } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { readMergePatch } from "@/lib/git-diff.ts";
import { failureMessage } from "@/lib/daemon-command.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import { ThreadLink } from "./thread-link.tsx";

export function MergeDialog(props: { thread: ThreadRef; onClose(): void }) {
  const client = useClient();
  const meta = useThreadMeta(props.thread.id);
  const sources = useThreadSources();
  const navigate = useNavigate();
  const toast = useToast();
  const read = useCallback(
    (reader: import("@ace/client").ThreadReader) => {
      for (let at = reader.order.length - 1; at >= 0; at--) {
        const item = reader.item(reader.order[at] ?? "");
        if (
          item?.type === "message" &&
          item.role === "assistant" &&
          item.complete &&
          !item.synthetic &&
          item.agentId === meta?.rootAgentId
        )
          return item;
      }
      return undefined;
    },
    [meta?.rootAgentId],
  );
  const answer = useThread(props.thread.id, ["thread", "order"], read);
  const [draft, setSummary] = useState<string>();
  const summary =
    draft ??
    answer?.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .slice(0, 16384) ??
    "";
  const [includeCode, setIncludeCode] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const parent = meta?.lineage?.parentThreadId;
  const bringBack = async () => {
    if (!parent || !answer || !summary.trim() || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await sources.actions.merge(
        props.thread,
        summary.trim(),
        [{ threadId: ThreadId.parse(props.thread.id), itemId: ItemId.parse(answer.id) }],
        includeCode ? await readMergePatch(client, props.thread.id) : undefined,
      );
      props.onClose();
      toast.add({
        title: "Results sent to parent",
        description: "The summary is available on its next turn.",
      });
      void navigate({ to: "/t/$threadId", params: { threadId: parent } });
    } catch (failure) {
      setError(failureMessage(failure));
      setSending(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !sending && props.onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void bringBack();
          }}
        >
          <DialogHeader>
            <DialogTitle>Bring back to parent</DialogTitle>
            <DialogDescription>
              Send a summary to{" "}
              {parent ? (
                <ThreadLink threadId={parent} fallback="the parent thread" />
              ) : (
                "the parent thread"
              )}
              . Its agent reads it on the next turn. This fork stays available.
            </DialogDescription>
          </DialogHeader>
          <label htmlFor="merge-summary" className="text-ui text-muted-foreground">
            Summary
          </label>
          <Textarea
            id="merge-summary"
            autoFocus
            value={summary}
            maxLength={16384}
            disabled={sending}
            onChange={(event) => setSummary(event.target.value)}
          />
          <label className="flex h-8 items-center gap-2 text-ui">
            <Checkbox checked={includeCode} disabled={sending} onCheckedChange={setIncludeCode} />{" "}
            Include code changes
          </label>
          <p className="text-xs text-muted-foreground">
            Includes uncommitted tracked changes only. Both threads must finish before code changes
            can be applied.
          </p>
          {!answer && (
            <p role="status" className="text-ui text-muted-foreground">
              Wait for an answer in this fork before bringing results back.
            </p>
          )}
          {error && (
            <p role="alert" className="text-ui text-status-failed">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={sending} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={sending || !answer || !summary.trim()}
            >
              {sending ? "Sending…" : "Bring back"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
