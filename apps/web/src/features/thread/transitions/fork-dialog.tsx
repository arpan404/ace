import { useThreadMeta } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage } from "@/lib/daemon-command.ts";
import { ForkModelPicker } from "./fork-model-picker.tsx";
import { runsNow } from "../composer/execution.ts";
import { useThreadSources, type Selection, type ThreadRef } from "../sources/index.ts";

/**
 * Fork from a finished turn: a new thread with the history up to there, starting with the
 * person's next message. The source thread keeps going untouched.
 */
export function ForkDialog(props: { thread: ThreadRef; point: ForkPoint; onClose(): void }) {
  const sources = useThreadSources();
  const toast = useToast();
  const navigate = useNavigate();
  const meta = useThreadMeta(props.thread.id);
  const [chosen, setSelection] = useState<Selection>();
  const selection = chosen ?? (meta && runsNow(meta));
  const [title, setTitle] = useState(() => `${props.thread.title} (fork)`.slice(0, 256));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const fork = async () => {
    const input = text.trim();
    if (!input || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const threadId = await sources.actions.fork(props.thread, {
        point: props.point,
        input,
        selection,
        title: title.trim() || undefined,
      });
      props.onClose();
      toast.add({ title: `Forked · ${props.thread.title}` });
      void navigate({ to: "/t/$threadId", params: { threadId } });
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
            void fork();
          }}
        >
          <DialogHeader>
            <DialogTitle>Fork from here</DialogTitle>
            <DialogDescription>
              A new thread starts with everything up to this turn. This thread carries on as it is.
            </DialogDescription>
          </DialogHeader>
          <label className="text-ui text-muted-foreground" htmlFor="fork-title">
            Title
          </label>
          <Input
            id="fork-title"
            value={title}
            maxLength={256}
            disabled={sending}
            onChange={(event) => setTitle(event.target.value)}
          />
          <ForkModelPicker selection={selection} onPick={setSelection} disabled={sending} />
          <Textarea
            aria-label="First message of the fork"
            placeholder="Try the other approach instead…"
            value={text}
            maxLength={16384}
            disabled={sending}
            autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void fork();
              }
            }}
          />
          {error && (
            <p role="alert" className="text-ui text-status-failed">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={sending} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!text.trim() || sending}>
              {sending ? "Forking…" : "Fork"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
