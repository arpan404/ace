import type { ClientApi } from "@ace/client";
import { frameBatch } from "@ace/client-react";
import { StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, AppFrame } from "./app.tsx";
import { ConnectionGate } from "./app/connection-gate.tsx";
import { defaultDaemonUrl, forgetToken, type DaemonTarget } from "./boot/connection-settings.ts";
import { DaemonConnectionContext } from "./boot/connection.tsx";
import { createDaemonClient } from "./boot/daemon.ts";
import { desktopConnection, desktopDaemon, hasDesktopBridge } from "./boot/desktop.ts";
import { webStorage } from "./boot/web-storage.ts";
import {
  BareBootFailure,
  BootFailure,
  DesktopFailureScreen,
  StartingScreen,
} from "./features/connect/index.ts";
import { markSeen } from "./features/thread/index.ts";
import { watchKeyboardInset } from "./lib/keyboard-inset.ts";
import { profileName, setProfileName } from "./lib/profile.ts";
import "./styles/index.css";

// A browser that denies site data throws on the first touch of storage; ace then starts with
// storage that lasts for this window instead of failing before it can say anything.
const local = webStorage(() => localStorage);
const session = webStorage(() => sessionStorage);
const environment = {
  storage: local,
  matchMedia: (query: string) => matchMedia(query),
  root: document.documentElement,
};
const stores = { local, session };
// Store changes reach React once per animation frame (none while the tab is hidden).
const batch = frameBatch((flush) => requestAnimationFrame(flush));
const app = (client: ClientApi) => <App client={client} storage={local} batch={batch} />;
const forgetFragment = () => history.replaceState(null, "", location.pathname + location.search);

function gate(options: { handed?: DaemonTarget | undefined; desktop?: boolean } = {}) {
  return (
    <ConnectionGate
      stores={stores}
      defaultUrl={options.handed?.url ?? import.meta.env.VITE_ACE_DAEMON_URL ?? defaultDaemonUrl}
      handed={options.handed}
      desktop={options.desktop ?? false}
      createClient={createDaemonClient}
      fragment={location.hash}
      onFragmentRead={forgetFragment}
    >
      {app}
    </ConnectionGate>
  );
}

async function content(): Promise<ReactNode> {
  // The fake daemon is only bundled in `vite --mode fake`.
  if (import.meta.env.MODE === "fake") {
    const fake = (await import("./boot/fake.ts")).bootFake();
    const { client, seen } = fake;
    for (const mark of seen) markSeen(mark.threadId, mark.itemId);
    if (!profileName(local)) setProfileName(local, fake.profileName);
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
  if (!hasDesktopBridge()) return gate();
  const desktop = await desktopConnection();
  if (desktop.kind === "target") return gate({ handed: desktop.target, desktop: true });
  // A computer that runs no daemon connects to one elsewhere, by address.
  if (desktop.kind === "none" || desktop.remoteOnly) return gate({ desktop: true });
  const daemon = desktopDaemon();
  return daemon ? (
    <DesktopFailureScreen reason={desktop.reason} daemon={daemon} />
  ) : (
    <BootFailure error={desktop.reason} />
  );
}

const element = document.getElementById("root");
if (!element) throw new Error("Missing #root");
const daemonMode = import.meta.env.MODE !== "fake" && import.meta.env.MODE !== "perf";
/** Start over at the connection screen without the stored token (from `BootFailure`). */
const connectionSettings = daemonMode
  ? () => {
      forgetToken(stores);
      location.reload();
    }
  : undefined;

async function start(root: Root) {
  // iOS covers the page with its keyboard instead of resizing it; bottom UI reads --kb-inset.
  watchKeyboardInset(window, document.documentElement);
  const render = (children: ReactNode) =>
    root.render(
      <StrictMode>
        <AppFrame environment={environment} onConnectionSettings={connectionSettings}>
          {children}
        </AppFrame>
      </StrictMode>,
    );
  // The desktop app hands over its daemon only once it answers; until then, say so calmly.
  // "Connect manually…" takes over from whatever the hand-off later says.
  let manual = false;
  if (hasDesktopBridge())
    render(
      <StartingScreen
        daemon={desktopDaemon()}
        onConnectManually={() => {
          manual = true;
          render(gate({ desktop: true }));
        }}
      />,
    );
  try {
    const shown = await content();
    if (!manual) render(shown);
  } catch (error) {
    console.error("ace couldn't start", error);
    render(<BootFailure error={error} onConnectionSettings={connectionSettings} />);
  }
}

// Anything the entry itself throws (before or around the providers) still reaches the screen,
// without the providers that may be what failed.
let root: Root | undefined;
try {
  root = createRoot(element);
  await start(root);
} catch (error) {
  console.error("ace couldn't start", error);
  if (root) root.render(<BareBootFailure error={error} />);
  else element.textContent = "ace couldn't start. Reload the page to try again.";
}
