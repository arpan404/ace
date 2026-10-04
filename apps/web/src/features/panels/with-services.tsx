import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { PanelServicesContext, useLoadedServices } from "./services.ts";

/** Provides the panel services (terminals, preview, drafts) once loaded, with a spinner until. */
export function WithServices(props: { children: ReactNode; quiet?: boolean }) {
  const services = useLoadedServices();
  if (!services)
    return props.quiet ? null : (
      <div className="grid h-full place-items-center">
        <Spinner label="Loading" />
      </div>
    );
  return (
    <PanelServicesContext.Provider value={services}>{props.children}</PanelServicesContext.Provider>
  );
}
