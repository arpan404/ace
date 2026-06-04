import { createRoot, type Root } from "react-dom/client";
import { CircleAlertIcon } from "lucide-react";

import { Button } from "./components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";

interface PendingConfirmRequest {
  readonly id: number;
  readonly message: string;
  readonly resolve: (confirmed: boolean) => void;
}

let nextRequestId = 0;
let pendingRequests: PendingConfirmRequest[] = [];
let activeRequest: PendingConfirmRequest | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function normalizeMessageLines(message: string): readonly string[] {
  const normalizedLines: string[] = [];
  for (const rawLine of message.split("\n")) {
    const line = rawLine.trim();
    if (line.length > 0) {
      normalizedLines.push(line);
    }
  }
  return normalizedLines;
}

function ensureRoot(): Root | null {
  if (typeof document === "undefined") {
    return null;
  }
  if (root) {
    return root;
  }
  container = document.createElement("div");
  container.dataset.slot = "confirm-dialog-fallback";
  document.body.append(container);
  root = createRoot(container);
  return root;
}

function disposeRoot(): void {
  if (root) {
    root.unmount();
  }
  root = null;
  if (container) {
    container.remove();
  }
  container = null;
}

function flushConfirmDialog(): void {
  const targetRoot = ensureRoot();
  if (!targetRoot) {
    const pending = activeRequest;
    activeRequest = null;
    pending?.resolve(false);
    while (pendingRequests.length > 0) {
      const request = pendingRequests.shift();
      request?.resolve(false);
    }
    return;
  }
  if (!activeRequest) {
    targetRoot.render(null);
    return;
  }
  const messageLines = normalizeMessageLines(activeRequest.message);
  const title = messageLines[0] ?? "Confirm action";
  const [description, ...details] = messageLines.slice(1);
  const settle = (confirmed: boolean) => {
    const currentRequest = activeRequest;
    activeRequest = null;
    currentRequest?.resolve(confirmed);
    const nextRequest = pendingRequests.shift() ?? null;
    activeRequest = nextRequest;
    if (!activeRequest && pendingRequests.length === 0) {
      disposeRoot();
      return;
    }
    flushConfirmDialog();
  };
  targetRoot.render(
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          settle(false);
        }
      }}
    >
      <AlertDialogContent key={activeRequest.id} className="gap-4">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-warning/12 text-warning">
            <CircleAlertIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && description.length > 0 ? (
            <AlertDialogDescription className="max-w-[32ch]">{description}</AlertDialogDescription>
          ) : null}
          {details.length > 0 ? (
            <div className="mt-2 grid gap-1.5 text-xs text-muted-foreground sm:col-start-2">
              {details.map((detail) => (
                <div
                  key={detail}
                  className="rounded-[var(--control-radius)] border border-border/55 bg-muted/35 px-2 py-1.5"
                >
                  {detail}
                </div>
              ))}
            </div>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button onClick={() => settle(true)}>Confirm</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  );
}

export function showConfirmDialogFallback(message: string): Promise<boolean> {
  if (typeof document === "undefined") {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const request: PendingConfirmRequest = {
      id: nextRequestId + 1,
      message,
      resolve,
    };
    nextRequestId = request.id;
    pendingRequests = [...pendingRequests, request];
    if (!activeRequest) {
      activeRequest = pendingRequests.shift() ?? null;
      flushConfirmDialog();
    }
  });
}
