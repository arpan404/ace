import { nextFrame } from "./lib/next-frame.ts";
import type { ClientApi } from "@ace/client";
import type { MachinePool } from "@ace/client-worker/machines";
import { frameBatch } from "@ace/client-react";
import { lazy, StrictMode, Suspense, useMemo, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, AppFrame, createQueryClient } from "./app.tsx";
import { ConnectionGate, type GateConnection } from "./app/connection-gate.tsx";
import {
  defaultDaemonUrl,
  forgetToken,
  loadTarget,
  type DaemonTarget,
} from "./boot/connection-settings.ts";
import { pairingLinkFromUrl } from "./boot/fragment-handoff.ts";
import { DaemonConnectionContext, type NoMachinePlace } from "./boot/connection.tsx";
import type { AccountRouteSource } from "./boot/main-machine.ts";
import { createDaemonClient, forgetDaemonIdentity } from "./boot/daemon.ts";
import { afterFirstScreen, useBrowserMachinePool } from "./boot/machine-pool-boot.ts";
import { loadKeptQueries, useKeptQueries } from "./boot/kept-queries.ts";
import { KeptTurnStepsConnection } from "./boot/kept-turn-steps.ts";
import {
  desktopConnection,
  desktopDaemon,
  hasDesktopBridge,
  setDesktopWindowBackground,
} from "./boot/desktop.ts";
import { desktopColorScheme } from "./boot/desktop-color-scheme.ts";
import { webStorage } from "./boot/web-storage.ts";
import { ACE_WEB_SIGN_IN_PATH } from "@ace/protocol/ace-account";
import {
  BareBootFailure,
  BootFailure,
  DesktopFailureScreen,
  SignInLanding,
  signInLandingStatus,
} from "./features/connect/index.ts";
import { StartupPending } from "./features/startup/index.ts";
// Named, not `import()`: the app already loads this module at startup, and a dynamic import
// would keep every export of it (dialogs, settings rows) in the startup chunk.
import {
  AceAccountBackendContext,
  AccountMachineConnectorContext,
} from "./features/ace-account/index.ts";
import { createStartup } from "./lib/startup/startup.tsx";
import { watchVisibleHeight } from "./lib/visible-height.ts";
import { profileName, setProfileName } from "./lib/profile.ts";
import { loadAppearance } from "./theme/appearance.ts";
import { glassEngine } from "./theme/glass.ts";
import { softwareRendering, webglRenderer } from "./theme/renderer.ts";
import { whenIdle } from "./lib/idle.ts";
import "./styles/index.css";

// A browser that denies site data throws on the first touch of storage; ace then starts with
// storage that lasts for this window instead of failing before it can say anything.
const local = webStorage(() => localStorage);
const session = webStorage(() => sessionStorage);
const environment = {
  storage: local,
  matchMedia: (query: string) => matchMedia(query),
  root: document.documentElement,
  glassEngine: glassEngine(navigator.userAgent, userAgentBrands()),
  softwareRendering: softwareRendering({
    storage: local,
    renderer: () => webglRenderer(document),
    idle: (task) => whenIdle(task),
    automated: navigator.webdriver === true,
  }),
  windowBackground: (value: { mode: string; light: string; dark: string }) =>
    setDesktopWindowBackground(value),
};
// Windows desktop app: the OS light/dark mode comes from the app (`desktop-color-scheme.ts`),
// asked before the first render so a reload after a Windows switch starts in the right scheme.
const colorScheme = desktopColorScheme(environment.matchMedia);
environment.matchMedia = colorScheme.matchMedia;
if (colorScheme.ready) {
  await colorScheme.ready;
  // The splash too: index.html resolved "System" from the page's stale guess.
  if (loadAppearance(local).mode === "system")
    document.documentElement.dataset.scheme = colorScheme.matchMedia("(prefers-color-scheme: dark)")
      .matches
      ? "dark"
      : "light";
}
const stores = { local, session };

/** `navigator.userAgentData.brands` where the browser has it (Chromium); not in every DOM lib. */
function userAgentBrands(): { brand: string }[] {
  const data: unknown = Reflect.get(navigator, "userAgentData");
  const brands: unknown = data && typeof data === "object" ? Reflect.get(data, "brands") : [];
  return Array.isArray(brands)
    ? brands.flatMap((entry: unknown) => {
        const brand: unknown =
          entry && typeof entry === "object" ? Reflect.get(entry, "brand") : undefined;
        return typeof brand === "string" ? [{ brand }] : [];
      })
    : [];
}
// Sidebar status stays live in hidden tabs; transcript streams stay in the worker.
const batch = frameBatch(nextFrame);
const app = (client: ClientApi, machines?: MachinePool) => (
  <App client={client} storage={local} windowStorage={session} batch={batch} machines={machines} />
);
/**
 * A real daemon's app, with the machine pool this browser has stored for its connection and its
 * lookups kept between sessions.
 */
function DaemonApp(props: { client: ClientApi; connection: GateConnection }) {
  const { pool, ensure } = useBrowserMachinePool(local, session, poolStart);
  const [queryClient] = useState(createQueryClient);
  useKeptQueries(queryClient, props.client, props.connection);
  const { target, hostId } = props.connection;
  const kept = useMemo(() => target && { target, hostId }, [target, hostId]);
  return (
    <KeptTurnStepsConnection.Provider value={kept}>
      <App
        client={props.client}
        queryClient={queryClient}
        storage={local}
        windowStorage={session}
        batch={batch}
        machines={pool}
        ensureMachines={ensure}
      />
    </KeptTurnStepsConnection.Provider>
  );
}
const daemonApp = (client: ClientApi, connection: GateConnection) => (
  <DaemonApp client={client} connection={connection} />
);
/** The app with no machine, loaded only when a window has none. */
const NoMachineApp = lazy(() =>
  import("./features/no-machine/index.ts").then((module) => ({ default: module.NoMachineApp })),
);
/** Left the connection screen for Profile or Fleet: the app opens there, before its router reads the address. */
function AtPlace(props: { place?: NoMachinePlace | undefined; children: ReactNode }) {
  useState(() => {
    if (props.place) history.replaceState(null, "", props.place);
  });
  return props.children;
}
/** A window with no machine yet: the app, empty, with the machine pool for account machines. */
function NoMachineWindow(props: { place?: NoMachinePlace | undefined }) {
  const { pool, ensure } = useBrowserMachinePool(local, session);
  return (
    <AtPlace place={props.place}>
      <Suspense fallback={null}>
        <NoMachineApp
          storage={local}
          windowStorage={session}
          machines={pool}
          ensureMachines={ensure}
        />
      </Suspense>
    </AtPlace>
  );
}
const noMachineWindow = (place?: NoMachinePlace) => <NoMachineWindow place={place} />;
/** Machines on the ace account open as this window's machine through ace's relay, on demand. */
const accountRoutes: AccountRouteSource = (machine) =>
  import("./boot/account-main-route.ts").then(({ browserAccountRoutes }) =>
    browserAccountRoutes({ storage: local, session })(machine),
  );
const forgetFragment = () => history.replaceState(null, "", location.pathname + location.search);

const pairingLink = pairingLinkFromUrl(new URL(location.href));

function gate(
  options: { handed?: DaemonTarget | undefined; desktop?: boolean; manual?: boolean } = {},
) {
  return (
    <ConnectionGate
      stores={stores}
      defaultUrl={
        options.handed?.url ??
        import.meta.env.VITE_ACE_DAEMON_URL ??
        (pairingLink
          ? location.origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/"
          : defaultDaemonUrl)
      }
      handed={options.handed}
      desktop={options.desktop ?? false}
      createClient={createDaemonClient}
      forgetIdentity={forgetDaemonIdentity}
      fragment={location.hash}
      pairingLink={pairingLink}
      onFragmentRead={forgetFragment}
      noMachine={noMachineWindow}
      accountRoutes={accountRoutes}
      manual={options.manual}
    >
      {daemonApp}
    </ConnectionGate>
  );
}

/** Fake mode with no machine: an address opens the fake daemon's own app, as before. */
function fakeElsewhere(): Promise<never> {
  session.removeItem?.("ace.fake.machine");
  location.assign("/");
  return new Promise<never>(() => {});
}

/**
 * Fake mode with no machine (`?machine=none`, signed out with `&account=out`), to see it: the
 * real connection gate, where Fleet's Open makes a fake account machine this window's (the
 * Studio asks for its code, 2468) and a reload opens it again. Kept in this tab only.
 */
async function fakeNoMachine(signedOut: boolean): Promise<ReactNode> {
  const [{ fakeNoMachineAccount }, { fakeAccountConnector }, { fakeAccountRoutes }, fake] =
    await Promise.all([
      import("./boot/fake-no-machine.ts"),
      import("./boot/fake-account.ts"),
      import("./boot/fake-account-main.ts"),
      import("./boot/fake.ts"),
    ]);
  const { daemon } = fake.bootFake();
  const routes = fakeAccountRoutes({ daemon, session, now: Date.now });
  return (
    <AceAccountBackendContext value={fakeNoMachineAccount(session, signedOut)}>
      <AccountMachineConnectorContext value={fakeAccountConnector(Date.now)}>
        <ConnectionGate
          stores={{ local: session, session }}
          defaultUrl={defaultDaemonUrl}
          createClient={fakeElsewhere}
          accountRoutes={routes}
          noMachine={(place) => (
            <AtPlace place={place}>
              <Suspense fallback={null}>
                <NoMachineApp storage={local} windowStorage={session} />
              </Suspense>
            </AtPlace>
          )}
        >
          {(client) => app(client)}
        </ConnectionGate>
      </AccountMachineConnectorContext>
    </AceAccountBackendContext>
  );
}

async function content(): Promise<ReactNode> {
  // The fake daemon is only bundled in `vite --mode fake`.
  if (import.meta.env.MODE === "fake") {
    // `?machine=none`: the app as a window with no machine sees it.
    const search = new URLSearchParams(location.search);
    // Kept for the tab, so a reload after opening an account machine (at `/`) stays in it.
    if (search.get("machine") === "none") session.setItem("ace.fake.machine", "none");
    if (session.getItem("ace.fake.machine") === "none")
      return fakeNoMachine(search.get("account") === "out");
    const fake = (await import("./boot/fake.ts")).bootFake();
    const { client } = fake;
    if (!profileName(local)) setProfileName(local, fake.profileName);
    await client.start();
    const machines = await fake.machines;
    const [
      { fakeAccountBackend, fakeAccountConnector },
      { BotStreamsContext },
      { fakeBotStreams },
    ] = await Promise.all([
      import("./boot/fake-account.ts"),
      import("./features/spade/index.ts"),
      import("./boot/fake-bot-streams.ts"),
    ]);
    return (
      <DaemonConnectionContext.Provider value={fake.connection}>
        <AceAccountBackendContext value={() => fakeAccountBackend(session, Date.now)}>
          <AccountMachineConnectorContext value={fakeAccountConnector(Date.now)}>
            {/* The bots' browser and screen pictures, drawn in the page. */}
            <BotStreamsContext value={fakeBotStreams()}>{app(client, machines)}</BotStreamsContext>
          </AccountMachineConnectorContext>
        </AceAccountBackendContext>
      </DaemonConnectionContext.Provider>
    );
  }
  // The endless-agent load test (tools/web-perf); only bundled in `vite --mode perf`.
  if (import.meta.env.MODE === "perf") {
    const { client } = (await import("./boot/perf.ts")).bootPerf();
    await client.start();
    return app(client);
  }
  if (!hasDesktopBridge()) {
    // Back from ace sign-in started in another tab (ADR 0100): that tab gets the session.
    if (location.pathname === ACE_WEB_SIGN_IN_PATH)
      return (
        <SignInLanding status={signInLandingStatus(location.search)} close={() => window.close()} />
      );
    return gate();
  }
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
// A browser with a machine stored keeps lookups from its last session: their code downloads
// while the gate connects, so the app restores them as it mounts. Not awaited.
if (daemonMode && !hasDesktopBridge() && loadTarget(stores).target)
  void loadKeptQueries().catch(() => {});
/** Start over at the connection screen without the stored token (from `BootFailure`). */
const connectionSettings = daemonMode
  ? () => {
      forgetToken(stores);
      location.reload();
    }
  : undefined;

// One startup screen per page load: it covers the window from first paint until the app has
// its first data, across the swap from connecting to the app.
const startup = createStartup({
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
  frame: nextFrame,
});

/**
 * Other machines connect once the first screen is up, unless the address opens a view on one of
 * them (`?machine=`), which needs the pool for that screen.
 */
const poolStart = new URLSearchParams(location.search).has("machine")
  ? undefined
  : afterFirstScreen(startup, (run) => whenIdle(run));

async function start(root: Root) {
  // iOS covers the page with its keyboard instead of resizing it; the app shell ends above it.
  watchVisibleHeight(window, document.documentElement);
  const daemon = desktopDaemon();
  const render = (children: ReactNode) =>
    root.render(
      <StrictMode>
        <AppFrame
          environment={environment}
          onConnectionSettings={connectionSettings}
          startup={startup}
          daemon={daemon}
        >
          {children}
        </AppFrame>
      </StrictMode>,
    );
  // The desktop app hands over its daemon only once it answers; until then the startup screen
  // waits calmly. "Connect manually…" takes over from whatever the hand-off later says.
  let manual = false;
  render(
    <StartupPending
      onConnectManually={
        hasDesktopBridge()
          ? () => {
              manual = true;
              render(gate({ desktop: true, manual: true }));
            }
          : undefined
      }
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
