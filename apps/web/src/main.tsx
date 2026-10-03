import type { Client } from "@ace/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, AppFrame } from "./app.tsx";
import { ConnectionGate } from "./boot/connection-gate.tsx";
import { defaultDaemonUrl } from "./boot/connection-settings.ts";
import { createDaemonClient } from "./boot/daemon.ts";
import { desktopTarget } from "./boot/desktop.ts";
import "./styles/index.css";

const environment = {
  storage: localStorage,
  matchMedia: (query: string) => matchMedia(query),
  root: document.documentElement,
};
const app = (client: Client) => <App client={client} storage={localStorage} />;
const forgetFragment = () => history.replaceState(null, "", location.pathname + location.search);

async function content() {
  // The fake daemon is only bundled in `vite --mode fake`.
  if (import.meta.env.MODE === "fake") {
    const { client } = (await import("./boot/fake.ts")).bootFake();
    await client.start();
    return app(client);
  }
  const desktop = await desktopTarget();
  return (
    <ConnectionGate
      stores={{ local: localStorage, session: sessionStorage }}
      defaultUrl={desktop?.url ?? import.meta.env.VITE_ACE_DAEMON_URL ?? defaultDaemonUrl}
      handed={desktop}
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
