import type { ClientApi } from "@ace/client";
import { frameBatch } from "@ace/client-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, AppFrame } from "./app.tsx";
import { ConnectionGate } from "./app/connection-gate.tsx";
import { defaultDaemonUrl } from "./boot/connection-settings.ts";
import { createDaemonClient } from "./boot/daemon.ts";
import "./styles/index.css";

const environment = {
  storage: localStorage,
  matchMedia: (query: string) => matchMedia(query),
  root: document.documentElement,
};
// Store changes reach React once per animation frame (none while the tab is hidden).
const batch = frameBatch((flush) => requestAnimationFrame(flush));
const app = (client: ClientApi) => <App client={client} storage={localStorage} batch={batch} />;
const forgetFragment = () => history.replaceState(null, "", location.pathname + location.search);

async function content() {
  // The fake daemon is only bundled in `vite --mode fake`.
  if (import.meta.env.MODE === "fake") {
    const { client } = (await import("./boot/fake.ts")).bootFake();
    await client.start();
    return app(client);
  }
  return (
    <ConnectionGate
      stores={{ local: localStorage, session: sessionStorage }}
      defaultUrl={import.meta.env.VITE_ACE_DAEMON_URL ?? defaultDaemonUrl}
      createClient={createDaemonClient}
      fragment={location.hash}
      onFragmentRead={forgetFragment}
    >
      {app}
    </ConnectionGate>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <AppFrame environment={environment}>{await content()}</AppFrame>
  </StrictMode>,
);
