import { createRoot, type Root } from "react-dom/client";

import { Button } from "./components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
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
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
  const description = messageLines.slice(1).join("\n");
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
      <AlertDialogContent key={activeRequest.id}>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">{title}</AlertDialogTitle>
          {description.length > 0 ? (
            <AlertDialogDescription className="whitespace-pre-line text-sm">
              {description}
            </AlertDialogDescription>
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
