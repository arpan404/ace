import type { Client } from "@ace/client";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App, AppFrame } from "./app.tsx";
import { ConnectionGate } from "./boot/connection-gate.tsx";
import { defaultDaemonUrl } from "./boot/connection-settings.ts";
import { createDaemonClient } from "./boot/daemon.ts";
import { desktopTarget, hasDesktopBridge } from "./boot/desktop.ts";
import { StartingScreen } from "./boot/starting-screen.tsx";
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

const element = document.getElementById("root");
if (!element) throw new Error("Missing #root");
const root = createRoot(element);
const render = (children: ReactNode) =>
  root.render(
    <StrictMode>
      <AppFrame environment={environment}>{children}</AppFrame>
    </StrictMode>,
  );
// The desktop app hands over its daemon only once it answers; until then, say so calmly.
if (hasDesktopBridge()) render(<StartingScreen />);
render(await content());
