import { addressHost } from "@ace/ui-core";
import { PaperclipIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { BrowserView } from "../sources.ts";
import type { BrowserFeatures } from "./use-browser-features.ts";

/**
 * A page in a tab opened its file picker. ace's own browser has no picker of its own, so the
 * person picks files on this device; they go to the page's input. The shown tab's comes first.
 */
export function PageFileChooser(props: {
  view: BrowserView;
  browser: Pick<BrowserFeatures, "chooseFiles">;
}) {
  const tabs = props.view.tabs ?? [];
  const tab =
    tabs.find((each) => each.tabId === props.view.activeTabId && each.fileChooser) ??
    tabs.find((each) => each.fileChooser);
  const chooser = tab?.fileChooser;
  const input = useRef<HTMLInputElement>(null);
  const [sent, setSent] = useState<string>();
  if (!tab || !chooser) return null;
  const site = addressHost(tab.url) ?? "This page";
  const sending = sent === chooser.chooserId;
  const send = (files: readonly File[]) => {
    if (sending) return;
    setSent(chooser.chooserId);
    void props.browser.chooseFiles(tab.tabId, chooser.chooserId, files).then((result) => {
      if (result === undefined)
        setSent((current) => (current === chooser.chooserId ? undefined : current));
    });
  };
  return (
    <section
      role="dialog"
      aria-label={`${site} asks for ${chooser.multiple ? "files" : "a file"}`}
      className="flex shrink-0 items-center gap-2 border-b bg-foreground/3 px-3 py-2.5 text-sm"
    >
      <PaperclipIcon aria-hidden size={15} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-muted-foreground">
        {site}
        {props.view.activeTabId && tab.tabId !== props.view.activeTabId && " (another tab)"}
        {` asks for ${chooser.multiple ? "files" : "a file"} from this device`}
      </span>
      <input
        ref={input}
        type="file"
        hidden
        aria-label="Files for the page"
        multiple={chooser.multiple}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) send(files);
        }}
      />
      <Button size="sm" variant="ghost" disabled={sending} onClick={() => send([])}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={sending}
        onClick={() => input.current?.click()}
      >
        {chooser.multiple ? "Choose files…" : "Choose file…"}
      </Button>
    </section>
  );
}
