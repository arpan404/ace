import { useClient } from "@ace/client-react";
import { Button } from "@/components/ui/button.tsx";
import { useEffect, type ReactNode } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { channelEndpoint } from "@/boot/main-machine.ts";
import { mediaFor } from "@/lib/video/media.ts";
import { mediaRelayFor } from "@/lib/video/media-relay.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { persistReview } from "./changes/review-store.ts";
import { PanelServicesContext, panelServices, usePanelServiceLoad } from "./services.ts";

/** Provides the panel services (terminals, preview, drafts) once loaded, with a spinner until. */
export function WithServices(props: { children: ReactNode; quiet?: boolean }) {
  const client = useClient();
  const state = usePanelServiceLoad();
  const endpoint = channelEndpoint(useDaemonConnection().endpoint);
  // A browser view's media connection reaches a relay-only daemon through the relay.
  useEffect(() => {
    const relay = mediaRelayFor(endpoint);
    if (relay && typeof client.onStream === "function") mediaFor(client).relayWith(relay);
  }, [client, endpoint]);
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
