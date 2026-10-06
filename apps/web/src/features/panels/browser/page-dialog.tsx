import { addressHost } from "@ace/ui-core";
import { ChatCenteredDotsIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { BrowserDialogView, BrowserView } from "../sources.ts";
import type { BrowserFeatures } from "./use-browser-features.ts";

const verbs: Record<BrowserDialogView["type"], { accept: string; dismiss?: string }> = {
  alert: { accept: "OK" },
  confirm: { accept: "OK", dismiss: "Cancel" },
  prompt: { accept: "OK", dismiss: "Cancel" },
  beforeunload: { accept: "Leave page", dismiss: "Stay" },
};

/**
 * A page's alert, confirm or prompt, waiting for an answer. Until it has one the page takes no
 * other command, from you or the agent. It may belong to a tab the page isn't showing; the
 * answer goes to that dialog by its own id, and taking control first is what the daemon needs.
 */
export function PageDialog(props: { view: BrowserView; browser: BrowserFeatures }) {
  const dialog =
    props.view.pendingDialog ?? props.view.tabs?.find((tab) => tab.pendingDialog)?.pendingDialog;
  const [text, setText] = useState<{ dialogId: string; value: string }>();
  const [sending, setSending] = useState(false);
  const inputId = useId();
  if (!dialog) return null;
  const tab = props.view.tabs?.find((each) => each.tabId === dialog.tabId);
  const site = addressHost(tab?.url ?? props.view.url) ?? "This page";
  const value = text?.dialogId === dialog.dialogId ? text.value : (dialog.defaultPrompt ?? "");
  const words = verbs[dialog.type];
  const answer = (accept: boolean) => {
    setSending(true);
    void props.browser
      .answerDialog(
        dialog.tabId,
        dialog.dialogId,
        accept,
        dialog.type === "prompt" && accept ? value : undefined,
      )
      .finally(() => setSending(false));
  };
  return (
    <section
      role="alertdialog"
      aria-label={`${site} asks`}
      className="flex shrink-0 flex-col gap-2 border-b bg-foreground/3 px-3 py-2.5"
    >
      <p className="flex items-start gap-2 text-sm">
        <ChatCenteredDotsIcon
          aria-hidden
          size={15}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground">
            {site}
            {props.view.activeTabId && dialog.tabId !== props.view.activeTabId && " (another tab)"}
            {" asks: "}
          </span>
          <span className="break-words whitespace-pre-wrap text-foreground">
            {dialog.message || (dialog.type === "beforeunload" ? "Leave this page?" : "")}
          </span>
        </span>
      </p>
      {dialog.type === "prompt" && (
        <Input
          id={inputId}
          aria-label="Answer"
          value={value}
          onChange={(event) => setText({ dialogId: dialog.dialogId, value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") answer(true);
          }}
        />
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="min-w-0 flex-1 text-xs text-subtle-foreground">
          The page waits for this answer; agents can't act on it meanwhile.
        </span>
        {words.dismiss && (
          <Button size="sm" variant="ghost" disabled={sending} onClick={() => answer(false)}>
            {words.dismiss}
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={sending} onClick={() => answer(true)}>
          {words.accept}
        </Button>
      </div>
    </section>
  );
}
