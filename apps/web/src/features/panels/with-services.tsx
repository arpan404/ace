import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { persistReview } from "./changes/review-store.ts";
import { PanelServicesContext, useLoadedServices } from "./services.ts";

/** Provides the panel services (terminals, preview, drafts) once loaded, with a spinner until. */
export function WithServices(props: { children: ReactNode; quiet?: boolean }) {
  const services = useLoadedServices();
  const { storage } = useLayout();
  if (!services)
    return props.quiet ? null : (
      <div className="grid h-full place-items-center">
        <Spinner label="Loading" />
      </div>
    );
  // Before any view reads them: review drafts, diff layout and viewed marks come back from
  // the last session (once per services; later calls do nothing).
  persistReview(services, storage);
  return (
    <PanelServicesContext.Provider value={services}>{props.children}</PanelServicesContext.Provider>
  );
}
