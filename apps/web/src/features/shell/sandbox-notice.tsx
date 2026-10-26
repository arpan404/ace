import { Suspense, useEffect, useState } from "react";
import { desktopSandbox, type SandboxNotice as Notice } from "@/boot/desktop-sandbox.ts";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** The restart question loads only when asked: dialogs stay out of the first paint. */
const RestartConfirm = deferredComponent(() =>
  import("./restart-confirm.tsx").then((module) => module.RestartConfirm),
);

/**
 * Chromium's sandbox on a Linux AppImage or tar.gz where AppArmor blocks it (desktop only):
 * one sentence on what is off, and the one-time setup that turns it on. Hidden otherwise.
 */
export function SandboxNotice(props: { scope?: object }) {
  const [sandbox] = useState(() => desktopSandbox(props.scope));
  const [notice, setNotice] = useState<Notice>({ state: "hidden" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<number | null | undefined>(undefined);
  const toast = useToast();
  const { copied, copy } = useCopy(() => toast.error({ title: "Couldn't copy the commands" }));
  useEffect(() => {
    if (!sandbox) return;
    let current = true;
    let announced = false;
    const stop = sandbox.onStatus((next) => {
      announced = true;
      setNotice(next);
    });
    void sandbox
      .current()
      .then((next) => {
        if (current && !announced) setNotice(next);
      })
      .catch(() => {});
    return () => {
      current = false;
      stop();
    };
  }, [sandbox]);
  useEffect(() => {
    if (notice.state === "restart") void RestartConfirm.preload().catch(() => {});
  }, [notice.state]);
  if (!sandbox || notice.state === "hidden") return null;
  const failed = (title: string) => () => toast.error({ title });
  const hide = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => void sandbox.hide().then(setNotice, failed("Couldn't hide the notice"))}
    >
      Hide
    </Button>
  );
  return (
    <div role="status" className="flex min-h-9 items-center gap-2 border-b px-4 text-ui">
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">{notice.sentence}</span>
      {notice.state === "offer" && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void sandbox.setup().then(setNotice, failed("Couldn't start the sandbox setup"))
            }
          >
            Set up sandbox
          </Button>
          {hide}
        </>
      )}
      {notice.state === "commands" && (
        <>
          <Button size="sm" variant="ghost" onClick={() => copy(notice.commands)}>
            {copied ? "Copied" : "Copy commands"}
          </Button>
          {hide}
        </>
      )}
      {notice.state === "restart" && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(true);
              setBusy(undefined);
              void sandbox.busy().then(setBusy, () => setBusy(null));
            }}
          >
            Restart
          </Button>
          {confirming && (
            <Suspense fallback={null}>
              <RestartConfirm.Component
                open={confirming}
                title="Restart to turn on the sandbox?"
                busy={busy}
                onOpenChange={setConfirming}
                onRestart={() => void sandbox.restart().catch(failed("Couldn't restart ace"))}
              />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}
