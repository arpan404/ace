import { useClient } from "@ace/client-react";
import { ThreadId, type Thread } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/input.tsx";

export function CursorContinuation({ thread }: { thread: Thread }) {
  const client = useClient();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const continueThread = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(undefined);
    const threadId = ThreadId.parse(crypto.randomUUID());
    try {
      const result = await client.command({
        type: "thread.create",
        threadId,
        provider: "cursor",
        workspaceId: thread.workspaceId,
        handoffFrom: thread.id,
        input: [{ type: "text", text: text.trim() }],
      });
      if (!result.ok) throw new Error(result.detail ?? "Couldn't continue this thread.");
      void navigate({ to: "/t/$threadId", params: { threadId } });
    } catch {
      setError("Couldn't continue this thread. Sign in to Cursor and try again.");
      setSending(false);
    }
  };
  return (
    <div className="relative px-4 pb-4 text-ui">
      <p>
        This Cursor CLI thread is read-only. Continue in a new Cursor thread with its saved history.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        The new thread starts with context from this conversation and can read its saved history.
      </p>
      {!editing ? (
        <Button className="mt-3" onClick={() => setEditing(true)}>
          Continue in a new thread
        </Button>
      ) : (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void continueThread();
          }}
        >
          <Textarea
            aria-label="First message in the new Cursor thread"
            value={text}
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" disabled={sending || !text.trim()}>
            {sending ? "Continuing…" : "Continue in a new thread"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
