import { useClient } from "@ace/client-react";
import { Button } from "@/components/ui/button.tsx";
import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { persistReview } from "./changes/review-store.ts";
import { PanelServicesContext, panelServices, usePanelServiceLoad } from "./services.ts";

/** Provides the panel services (terminals, preview, drafts) once loaded, with a spinner until. */
export function WithServices(props: { children: ReactNode; quiet?: boolean }) {
  const client = useClient();
  const state = usePanelServiceLoad();
  const { storage } = useLayout();
  if (state.status === "failed")
    return (
      <div role="alert" className="p-4 text-sm">
        <p>Couldn’t load the panels: {state.message}</p>
        <Button
          onClick={() => {
            void panelServices(client).catch(() => {});
          }}
        >
          Try again
        </Button>
        <Button onClick={() => location.reload()}>Reload</Button>
      </div>
    );
  if (state.status === "loading")
    return props.quiet ? null : (
      <div className="grid h-full place-items-center">
        <Spinner label="Loading" />
      </div>
    );
  const services = state.services;
  // Before any view reads them: review drafts, diff layout and viewed marks come back from
  // the last session (once per services; later calls do nothing).
  persistReview(services, storage);
  return (
    <PanelServicesContext.Provider value={services}>{props.children}</PanelServicesContext.Provider>
  );
}
