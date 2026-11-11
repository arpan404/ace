import type { ClientApi } from "@ace/client";
import type { OutsideAccessRequest } from "@ace/protocol";
import {
  accessRequestSentence,
  clientTitle,
  screenUseSentence,
} from "@ace/ui-core/outside-clients";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { notifySystem } from "@/lib/browser-notify.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { documentVisibility } from "@/lib/page-visibility.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import {
  decideAccess,
  readOutside,
  stopScreen,
  watchOutside,
  type OutsideNow,
} from "./data/outside.ts";

/** The review dialog loads only when asked: dialogs stay out of the first paint. */
const AccessDialog = deferredComponent(() =>
  import("./access-dialog.tsx").then((module) => module.AccessDialog),
);

const noticeRow = "flex min-h-9 items-center gap-2 border-b px-4 text-ui";

/** "this Mac" for the computer this window runs on, else the machine's name. */
function placeOf(machine: Machine): string {
  if (!machine.primary) return machine.name;
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
  return mac ? "this Mac" : "this computer";
}

function useOutsideNow(client: ClientApi): OutsideNow | undefined {
  const [subscribe] = useState(() => (changed: () => void) => {
    const watch = watchOutside(client);
    watch.listeners.add(changed);
    return () => void watch.listeners.delete(changed);
  });
  const read = () => readOutside(client);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Outside MCP clients asking to sign in to, or using the screen of, any machine this window
 * reaches (ADR 0117): one line each, with text buttons, beside the other machine-level notices.
 * Only administrator windows are told, so others show nothing.
 */
export function OutsideNotices() {
  const machines = useMachines().filter((machine) => machine.client);
  return (
    <>
      {machines.map((machine) =>
        machine.client ? (
          <MachineOutside key={machine.id} machine={machine} client={machine.client} />
        ) : null,
      )}
    </>
  );
}

function MachineOutside(props: { machine: Machine; client: ClientApi }) {
  const { machine, client } = props;
  const now = useOutsideNow(client);
  const toast = useToast();
  const [reviewing, setReviewing] = useState<string>();
  const [pending, setPending] = useState<string>();
  useRequestAlerts(machine, now?.access);
  if (!now) return null;
  const place = placeOf(machine);
  const open = now.access.find((request) => request.requestId === reviewing);
  const act = (key: string, run: () => Promise<void>, failed: string) => {
    setPending(key);
    void run()
      .catch((error: unknown) =>
        toast.error({
          title: failed,
          description: error instanceof Error && error.message ? error.message : undefined,
        }),
      )
      .finally(() => setPending(undefined));
  };
  return (
    <>
      {now.access.map((request) => (
        <div key={request.requestId} role="status" className={noticeRow}>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {accessRequestSentence(request, machine.name)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setReviewing(request.requestId)}>
            Review
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending === request.requestId}
            onClick={() =>
              act(
                request.requestId,
                () => decideAccess(client, request.requestId, { decision: "deny" }),
                "Couldn't deny it",
              )
            }
          >
            Deny
          </Button>
        </div>
      ))}
      {now.screen.map((use) => (
        <div key={use.grantId} role="status" className={noticeRow}>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {screenUseSentence([use.name], place)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending === use.grantId}
            onClick={() =>
              act(use.grantId, () => stopScreen(client, use.grantId), "Couldn't stop it")
            }
          >
            Stop
          </Button>
        </div>
      ))}
      {open && (
        <MachineScope machine={machine}>
          <Suspense fallback={null}>
            <AccessDialog.Component
              client={client}
              machine={machine.name}
              request={open}
              onClose={() => setReviewing(undefined)}
            />
          </Suspense>
        </MachineScope>
      )}
    </>
  );
}

/**
 * A system notification for each new request while the window is behind (the desktop app's own,
 * or a browser tab's that allowed it); in front, the notice line says it.
 */
function useRequestAlerts(machine: Machine, access: readonly OutsideAccessRequest[] | undefined) {
  const seen = useRef<Set<string>>(undefined);
  useEffect(() => {
    if (!access) return;
    const ids = new Set(access.map((request) => request.requestId));
    const previous = seen.current;
    seen.current = ids;
    // What was pending when the watch began is on the notice line; only new ones alert.
    if (!previous || documentVisibility.visible()) return;
    for (const request of access) {
      if (previous.has(request.requestId)) continue;
      notifySystem({
        title: `${clientTitle(request.clientName, request.domain)} wants to use ${machine.name}`,
        body: `Review in ace. Code ${request.matchCode}.`,
        tag: `outside:${request.requestId}`,
        open: () => {},
      });
    }
  }, [access, machine.name]);
}
