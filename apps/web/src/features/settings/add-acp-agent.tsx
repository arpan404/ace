import { Suspense, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** The registry browser loads when someone first opens it (or hovers its button). */
const Registry = deferredComponent(() =>
  import("./acp-registry/registry-dialog.tsx").then((module) => module.default),
);

/**
 * Opens the ACP registry browser: search, review an install plan, install. `agentId` opens
 * straight on that entry (Update on an agent's page).
 */
export function AddAcpAgent(props: {
  agentId?: string | undefined;
  children?: ReactNode;
  variant?: "secondary" | "primary";
}) {
  const [open, setOpen] = useState(false);
  // Mounted from the first open on, so closing animates out.
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant={props.variant ?? "secondary"}
        onPointerEnter={() => void Registry.preload()}
        onFocus={() => void Registry.preload()}
        onClick={() => {
          setOpened(true);
          setOpen(true);
        }}
      >
        {props.children ?? "Add"}
      </Button>
      {opened && (
        <Suspense fallback={null}>
          <Registry.Component open={open} onOpenChange={setOpen} agentId={props.agentId} />
        </Suspense>
      )}
    </>
  );
}
