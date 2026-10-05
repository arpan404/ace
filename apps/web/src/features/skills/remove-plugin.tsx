import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
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
import { setPluginHidden, useRemovePluginNow } from "./skills-source.ts";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "The plugin service didn't answer.";

/**
 * Remove a plugin with Undo: it leaves the catalog at once, and the daemon only removes it once
 * the toast has gone without Undo. Removing drops the install, its availability and the
 * reviewed pin, so getting it back otherwise means a new review.
 */
export function useRemovePlugin(): (plugin: string) => void {
  const removeNow = useRemovePluginNow();
  const toast = useToast();
  return useCallback(
    (plugin: string) => {
      let undone = false;
      setPluginHidden(plugin, true);
      const toastId = toast.add({
        title: `Removed ${plugin}`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            undone = true;
            setPluginHidden(plugin, false);
            toast.close(toastId);
          },
        },
        onClose: () => {
          if (undone) return;
          removeNow(plugin).then(
            () => setPluginHidden(plugin, false),
            (error: unknown) => {
              setPluginHidden(plugin, false);
              toast.error({ title: `Couldn't remove ${plugin}`, description: errorText(error) });
            },
          );
        },
      });
    },
    [removeNow, toast],
  );
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
