import { Suspense, useState } from "react";
import { SettingAddRow } from "@/components/setting-row.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** The form loads when someone first opens it (or points at its row). */
const ManualAgentDialog = deferredComponent(() =>
  import("./acp-registry/manual-agent-dialog.tsx").then((module) => module.default),
);

/**
 * The last row of the ACP agents group: add an agent the registry doesn't list, by the command
 * that starts it. The dialog stays mounted from the first open on, so closing animates out.
 */
export function AddAgentByCommandRow() {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const preload = () => void ManualAgentDialog.preload();
  return (
    <>
      <SettingAddRow
        onPointerEnter={preload}
        onFocus={preload}
        onClick={() => {
          setOpened(true);
          setOpen(true);
        }}
      >
        Add an agent by command
      </SettingAddRow>
      {opened && (
        <Suspense fallback={null}>
          <ManualAgentDialog.Component open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  );
}
