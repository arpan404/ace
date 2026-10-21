import { Suspense, useState, type ReactNode } from "react";
import { SettingAddRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** The registry browser loads when someone first opens it (or hovers its button). */
const Registry = deferredComponent(() =>
  import("./acp-registry/registry-dialog.tsx").then((module) => module.default),
);

/**
 * The ACP registry browser behind an opener: search, review an install plan, install. `agentId`
 * opens straight on that entry (Update on an agent's page). Mounted from the first open on, so
 * closing animates out.
 */
function useRegistryDialog(agentId: string | undefined) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return {
    preload: () => void Registry.preload(),
    show: () => {
      setOpened(true);
      setOpen(true);
    },
    dialog: opened && (
      <Suspense fallback={null}>
        <Registry.Component open={open} onOpenChange={setOpen} agentId={agentId} />
      </Suspense>
    ),
  };
}

/** A button that opens the ACP registry browser. */
export function AddAcpAgent(props: {
  agentId?: string | undefined;
  children?: ReactNode;
  variant?: "secondary" | "primary";
}) {
  const registry = useRegistryDialog(props.agentId);
  return (
    <>
      <Button
        size="sm"
        variant={props.variant ?? "secondary"}
        onPointerEnter={registry.preload}
        onFocus={registry.preload}
        onClick={registry.show}
      >
        {props.children ?? "Add"}
      </Button>
      {registry.dialog}
    </>
  );
}

/** The add row of a providers group that opens the ACP registry browser. */
export function AddAcpAgentRow(props: { children: ReactNode }) {
  const registry = useRegistryDialog(undefined);
  return (
    <>
      <SettingAddRow
        onPointerEnter={registry.preload}
        onFocus={registry.preload}
        onClick={registry.show}
      >
        {props.children}
      </SettingAddRow>
      {registry.dialog}
    </>
  );
}
