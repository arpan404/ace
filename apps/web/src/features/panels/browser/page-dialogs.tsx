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
import type { PageSource } from "./use-page-actions.ts";

/** The page's source as the server sent it, read-only, with Copy. */
export function PageSourceDialog(props: { source: PageSource | undefined; onClose(): void }) {
  const toast = useToast();
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
          <Button
            variant="secondary"
            onClick={() =>
              source &&
              void navigator.clipboard?.writeText(source.source).then(
                () => toast.add({ title: "Source copied" }),
                () => toast.error({ title: "Couldn't copy the source" }),
              )
            }
          >
            Copy source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Clear browsing data: what goes, for which browser, and a danger action with focus on Cancel.
 * In ace's Chrome every thread shares the profile, so it says so.
 */
export function ClearDataDialog(props: {
  open: boolean;
  engine: "embedded" | "headless" | "user" | undefined;
  onOpenChange(open: boolean): void;
  onClear(): Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const shared = props.engine === "headless";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Clear browsing data?</DialogTitle>
          <DialogDescription>
            {shared
              ? "Signs you out of sites in ace's Chrome, which every thread shares: cookies and the cache go everywhere, and site storage goes for the sites open in this thread. This thread's history goes too."
              : "Signs you out of sites in this thread's browser: its cookies, cache, site storage and history go."}
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
