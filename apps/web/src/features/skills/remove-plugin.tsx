import { useNavigate } from "@tanstack/react-router";
import { useClient, useConnectionState } from "@ace/client-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { shippedText, type Skill } from "./skills-model.ts";
import {
  reconcileRemovals,
  removeNow,
  scheduleRemoval,
  undoRemoval,
  undoWindowMs,
  type RemovalRunner,
} from "./plugin-removals.ts";
import { useRemovePluginNow } from "./skills-source.ts";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The plugin service didn't answer.";

/** How a removal reaches this daemon, and how a refusal is told. */
function useRemovalRunner(): RemovalRunner {
  const removePlugin = useRemovePluginNow();
  const client = useClient();
  const toast = useToast();
  return useMemo(
    () => ({
      remove: removePlugin,
      online: () => client.state === "ready",
      failed: (plugin, error) =>
        toast.error({ title: `Couldn't remove ${plugin}`, description: errorText(error) }),
    }),
    [removePlugin, client, toast],
  );
}

/**
 * Remove a plugin with Undo: it leaves the catalog at once, and the daemon removes it once Undo
 * has gone (`undoWindowMs`). The pending removal is kept on this device, so a reload inside the
 * window still completes it. Removing drops the install, its availability and the reviewed
 * pin, so getting it back otherwise means a new review.
 */
export function useRemovePlugin(): (plugin: string) => void {
  const runner = useRemovalRunner();
  const daemon = useDaemonConnection().url;
  const toast = useToast();
  return useCallback(
    (plugin: string) => {
      let undone = false;
      scheduleRemoval(daemon, plugin, runner, Date.now());
      const toastId = toast.add({
        title: `Removed ${plugin}`,
        timeout: undoWindowMs,
        actionProps: {
          children: "Undo",
          onClick: () => {
            undone = true;
            undoRemoval(daemon, plugin);
            toast.close(toastId);
          },
        },
        // Dismissed early: no need to wait out the window.
        onClose: () => undone || removeNow(daemon, plugin, runner),
      });
    },
    [runner, daemon, toast],
  );
}

/**
 * Finish removals confirmed before a reload, or that failed while offline, once this daemon is
 * connected. Mount wherever Skills shows.
 */
export function useRemovalReconciler(): void {
  const runner = useRemovalRunner();
  const daemon = useDaemonConnection().url;
  const ready = useConnectionState() === "ready";
  useEffect(() => {
    if (ready) reconcileRemovals(daemon, runner, Date.now());
  }, [ready, daemon, runner]);
}

/**
 * "Remove engineering?": what stops loading, and that a reinstall needs a new review. Cancel
 * has focus, so Enter never removes by accident.
 */
export function RemovePluginDialog(props: {
  plugin: string;
  /** What the plugin ships, for the count in the body. */
  components: readonly Skill[];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { plugin, components } = props;
  const cancel = useRef<HTMLButtonElement>(null);
  const remove = useRemovePlugin();
  const navigate = useNavigate();
  const ships = shippedText(components);
  const stops = components.length === 1 ? "stops" : "stop";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent initialFocus={cancel}>
        <DialogHeader>
          <DialogTitle>Remove {plugin}?</DialogTitle>
          <DialogDescription>
            {ships
              ? `Its ${ships} ${stops} loading for every provider.`
              : "It stops loading for every provider."}{" "}
            Installing it again needs a new review.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancel} variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              props.onOpenChange(false);
              remove(plugin);
              void navigate({ to: "/skills" });
            }}
          >
            Remove plugin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
