import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { registerAppConfirmHandler } from "../lib/appConfirm";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";

interface PendingConfirmRequest {
  readonly id: number;
  readonly message: string;
  readonly resolve: (confirmed: boolean) => void;
}

function normalizeMessageLines(message: string): readonly string[] {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function AppConfirmDialogHost() {
  const [queue, setQueue] = useState<readonly PendingConfirmRequest[]>([]);
  const queueRef = useRef<readonly PendingConfirmRequest[]>([]);
  const requestIdRef = useRef(0);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const settleActiveRequest = useCallback((confirmed: boolean) => {
    setQueue((current) => {
      const [activeRequest, ...rest] = current;
      if (!activeRequest) {
        return current;
      }
      activeRequest.resolve(confirmed);
      return rest;
    });
  }, []);

  useEffect(() => {
    return registerAppConfirmHandler(
      (message) =>
        new Promise<boolean>((resolve) => {
          const nextId = requestIdRef.current + 1;
          requestIdRef.current = nextId;
          setQueue((current) => [...current, { id: nextId, message, resolve }]);
        }),
    );
  }, []);

  useEffect(
    () => () => {
      for (const request of queueRef.current) {
        request.resolve(false);
      }
    },
    [],
  );

  const activeRequest = queue[0] ?? null;
  const messageLines = useMemo(
    () => (activeRequest ? normalizeMessageLines(activeRequest.message) : []),
    [activeRequest],
  );
  const title = messageLines[0] ?? "Confirm action";
  const description = messageLines.slice(1).join("\n");

  return (
    <AlertDialog
      open={activeRequest !== null}
      onOpenChange={(open) => {
        if (!open) {
          settleActiveRequest(false);
        }
      }}
    >
      <AlertDialogPopup key={activeRequest?.id ?? "idle"} bottomStickOnMobile={false}>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">{title}</AlertDialogTitle>
          {description.length > 0 ? (
            <AlertDialogDescription className="whitespace-pre-line text-sm">
              {description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => settleActiveRequest(false)}>
            Cancel
          </Button>
          <Button onClick={() => settleActiveRequest(true)}>Confirm</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
