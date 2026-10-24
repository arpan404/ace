import { Suspense, useEffect } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";
import { useTransferOpener, useTransferRequest } from "@/lib/transfer-opener.ts";

const TransferDialog = deferredComponent(() =>
  import("./transfer-dialog.tsx").then((module) => module.TransferDialog),
);

/**
 * Where "Continue on…" and "Open on…" ask which machine: mounted once in the shell, drawn only
 * after a menu has asked, and kept for its exit animation.
 */
export function TransferHost() {
  const opener = useTransferOpener();
  const { request, open, opening } = useTransferRequest();
  useEffect(() => whenIdle(() => void TransferDialog.preload().catch(() => {}), 6_000), []);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <TransferDialog.Component
        key={opening}
        request={request}
        open={open}
        onClose={() => opener.close()}
      />
    </Suspense>
  );
}
