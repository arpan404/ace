import { useState } from "react";
import { addressHost, displayAddress } from "@ace/ui-core";
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
import { useCopy } from "@/components/use-copy.ts";
import type { PageSource } from "./use-page-actions.ts";

/** The page's source as the server sent it, read-only, with Copy. */
export function PageSourceDialog(props: { source: PageSource | undefined; onClose(): void }) {
  const toast = useToast();
  const { copied, copy } = useCopy(() => toast.error({ title: "Couldn't copy the source" }));
  const { source } = props;
  return (
    <Dialog open={!!source} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg" className="h-[min(720px,calc(100vh-4rem))]">
        <DialogHeader>
          <DialogTitle>Source of {addressHost(source?.url ?? "") ?? "the page"}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {displayAddress(source?.url ?? "")}
            {source?.truncated && " · first 2 MB"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mx-0 rounded-md bg-(--code) px-0">
          <pre
            aria-label="Page source"
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region takes focus so keys scroll it
            tabIndex={0}
            className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre text-foreground outline-none focus-ring-inset"
          >
            {source?.source}
          </pre>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Close
          </Button>
          <Button variant="secondary" onClick={() => source && copy(source.source)}>
            {copied ? "Copied" : "Copy source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Clear browsing data: what goes, and a danger action with focus on Cancel. Clearing acts on
 * the browser profile the thread uses, which other threads share unless Settings › Browser ›
 * Browser profile gives each thread its own (or new browsers are private), so it says so.
 */
export function ClearDataDialog(props: {
  open: boolean;
  engine: "embedded" | "headless" | "user" | undefined;
  onOpenChange(open: boolean): void;
  onClear(): Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  // ace's Chrome can't list every site with stored data: storage goes for this thread's sites.
  const what =
    props.engine === "headless"
      ? "every cookie and the cache in the browser profile this thread uses, site storage of the sites open in this thread, and this thread's history"
      : "cookies, the cache and site storage in the browser profile this thread uses, and this thread's history";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Clear browsing data?</DialogTitle>
          <DialogDescription>
            Clears {what}. Threads that share this profile are signed out too. Settings › Browser ›
            Browser profile decides whether threads share one.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void props.onClear().then((done) => {
                setBusy(false);
                if (done) props.onOpenChange(false);
              });
            }}
          >
            Clear data
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
