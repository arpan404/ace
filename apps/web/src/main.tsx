import type { ClientApi } from "@ace/client";
import { frameBatch } from "@ace/client-react";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App, AppFrame } from "./app.tsx";
import { ConnectionGate } from "./app/connection-gate.tsx";
import { defaultDaemonUrl } from "./boot/connection-settings.ts";
import { DaemonConnectionContext } from "./boot/connection.tsx";
import { createDaemonClient } from "./boot/daemon.ts";
import { desktopTarget, hasDesktopBridge } from "./boot/desktop.ts";
import { StartingScreen } from "./features/connect/index.ts";
import { profileName, setProfileName } from "./lib/profile.ts";
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
    const fake = (await import("./boot/fake.ts")).bootFake();
    const { client } = fake;
    if (!profileName(localStorage)) setProfileName(localStorage, fake.profileName);
    await client.start();
    return (
      <DaemonConnectionContext.Provider value={fake.connection}>
        {app(client)}
      </DaemonConnectionContext.Provider>
    );
  }
  // The endless-agent load test (tools/web-perf); only bundled in `vite --mode perf`.
  if (import.meta.env.MODE === "perf") {
    const { client } = (await import("./boot/perf.ts")).bootPerf();
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
