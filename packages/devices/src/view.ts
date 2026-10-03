/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { z } from "zod";
import type { DeviceOperation, DeviceState } from "@ace/protocol/devices";
import { DeviceClient, DeviceClientError } from "./client.ts";
import { addDeviceControls } from "./view-controls.ts";
import { createDeviceImage } from "./view-stream.ts";

export interface DevicePanelOptions {
  document: Document;
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
  threadId(): string | undefined;
  agents(): readonly { id: string; name: string }[];
  downloadArtifact(artifactId: string): void | Promise<void>;
  /** Hosts connect these buttons to their existing browser and screen panels. */
  openBrowser?: () => void;
  openComputer?: () => void;
}
const enabledResult = z.object({ enabled: z.boolean() });

/** Reusable DOM host. Expo consumes DeviceClient with a native image renderer instead. */
export function mountDevicePanel(
  container: HTMLElement,
  client: DeviceClient,
  options: DevicePanelOptions,
): () => void {
  const doc = options.document;
  const panel = doc.createElement("section");
  panel.setAttribute("aria-label", "Devices");
  panel.style.cssText =
    "display:grid;gap:12px;max-width:820px;padding:16px;font:14px system-ui;color:inherit";
  const heading = doc.createElement("h2");
  heading.textContent = "Devices";
  const toolbar = doc.createElement("div");
  toolbar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
  const select = doc.createElement("select");
  select.setAttribute("aria-label", "Simulator or emulator");
  const status = doc.createElement("div");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const error = doc.createElement("div");
  error.setAttribute("role", "alert");
  error.style.whiteSpace = "pre-line";
  const controls = doc.createElement("div");
  controls.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
  const logs = doc.createElement("pre");
  logs.setAttribute("aria-label", "Device log tail");
  logs.style.cssText = "max-height:200px;overflow:auto;white-space:pre-wrap;font-size:12px";
  let selected = "";
  let state: DeviceState | undefined;
  let connected = false;
  let enabled = false;
  let destroyed = false;
  let subscribed: string | undefined;
  let subscribing: string | undefined;
  let releaseFrames: (() => void) | undefined;
  let releaseLogs: (() => void) | undefined;
  let refreshControls: (() => void) | undefined;
  let pending = 0;
  let seenConnected = false;
  let cancelLeaseTimer: (() => void) | undefined;
  let leaseTimerEpoch = 0;
  let logTail: string[] = [];
  const buttons: { element: HTMLButtonElement; enabled(): boolean }[] = [];
  const showError = (failure: unknown) => {
    if (destroyed) return;
    error.textContent =
      failure instanceof DeviceClientError
        ? `${failure.message} ${failure.hint}`
        : failure instanceof Error
          ? failure.message
          : "Device operation failed";
  };
  const canInput = () =>
    connected &&
    !!selected &&
    state?.controller === "human" &&
    (state.leaseExpiresAt ?? 0) > options.now();
  const refreshButtons = () => {
    for (const entry of buttons)
      entry.element.disabled = destroyed || pending > 0 || !entry.enabled();
    select.disabled = !connected || pending > 0;
    refreshControls?.();
  };
  const run = async (operation: DeviceOperation): Promise<unknown> => {
    pending++;
    error.textContent = "";
    refreshButtons();
    try {
      return await client.request(operation);
    } finally {
      pending--;
      if (!destroyed) refreshButtons();
    }
  };
  function button(
    parent: HTMLElement,
    title: string,
    action: () => void | Promise<void>,
    allowed: () => boolean,
  ) {
    const element = doc.createElement("button");
    element.type = "button";
    element.textContent = title;
    element.addEventListener("click", () => {
      if (!element.disabled) void Promise.resolve().then(action).catch(showError);
    });
    buttons.push({ element, enabled: allowed });
    parent.append(element);
    return element;
  }
  const stream = createDeviceImage(doc, {
    now: options.now,
    canInput: () => canInput() && pending === 0,
    active: () => !destroyed && connected,
    input: async (input) => {
      if (canInput()) await run({ op: "input", deviceId: selected, input });
    },
    error: showError,
  });
  const controlsView = addDeviceControls(controls, {
    document: doc,
    deviceId: () => selected,
    state: () => state,
    ready: () => connected && !!selected,
    enabled: () => enabled,
    canInput,
    threadId: options.threadId,
    run,
    button,
    started: (deviceId) => {
      subscribed = deviceId;
    },
    stopped: () => {
      subscribed = undefined;
      stream.clear();
    },
    downloadArtifact: options.downloadArtifact,
  });
  refreshControls = controlsView.refresh;
  panel.append(heading, toolbar, status, error, stream.element, controls, logs);
  container.append(panel);
  const attachSelected = () => {
    releaseFrames?.();
    releaseLogs?.();
    releaseFrames = undefined;
    releaseLogs = undefined;
    stream.clear();
    logTail = [];
    logs.textContent = "";
    if (!selected) return;
    releaseFrames = client.watchFrames(selected, stream.render);
    releaseLogs = client.watchLogs(selected, (batch) => {
      logTail.push(...batch.lines);
      if (logTail.length > 256) logTail = logTail.slice(-256);
      logs.textContent = `${batch.dropped ? `${batch.dropped} log lines dropped\n` : ""}${logTail.join("\n")}`;
    });
  };
  const choose = async () => {
    const previous = selected;
    const previousStream = subscribed;
    subscribed = undefined;
    selected = select.value;
    state = client.getSnapshot().states.find((entry) => entry.device.id === selected);
    attachSelected();
    refreshButtons();
    if (previous && connected) {
      if (previousStream) await run({ op: "unsubscribe", deviceId: previousStream });
      await run({ op: "logs.stop", deviceId: previous });
    }
    if (connected && state?.lifecycle === "live") {
      const deviceId = selected;
      await run({ op: "subscribe", deviceId });
      subscribed = deviceId;
    }
  };
  toolbar.append(select);
  button(
    toolbar,
    "Refresh devices",
    async () => {
      await run({ op: "list" });
      await run({ op: "states" });
    },
    () => connected,
  );
  button(
    toolbar,
    "Enable devices",
    async () => {
      enabled = enabledResult.parse(await run({ op: "enable", enabled: true })).enabled;
      refreshButtons();
    },
    () => connected && !enabled,
  );
  button(
    toolbar,
    "Disable devices",
    async () => {
      await run({ op: "enable", enabled: false });
      enabled = false;
      stream.clear();
      refreshButtons();
    },
    () => connected && enabled,
  );
  if (options.openBrowser) button(toolbar, "Browser", options.openBrowser, () => true);
  if (options.openComputer) button(toolbar, "Computer", options.openComputer, () => true);
  select.addEventListener("change", () => {
    void choose().catch(showError);
  });
  const unwatch = client.watch((snapshot) => {
    if (destroyed) return;
    connected = snapshot.connected;
    if (!connected) {
      stream.clear();
      subscribed = undefined;
      subscribing = undefined;
      seenConnected = false;
      enabled = false;
    }
    if (snapshot.error) showError(snapshot.error);
    if (snapshot.issues.length)
      error.textContent = snapshot.issues
        .map((issue) => `${issue.message} ${issue.hint}`)
        .join("\n");
    const devices = snapshot.devices.length
      ? snapshot.devices
      : snapshot.states.map((entry) => entry.device);
    const chosen = selected;
    select.replaceChildren();
    for (const device of devices) {
      const option = doc.createElement("option");
      option.value = device.id;
      option.textContent = `${device.platform === "ios" ? "iOS" : "Android"} · ${device.name} · ${device.state}`;
      select.append(option);
    }
    if (devices.some((device) => device.id === chosen)) select.value = chosen;
    if (selected !== select.value) {
      const previous = selected;
      const previousStream = subscribed;
      subscribed = undefined;
      if (connected && previousStream)
        void client.request({ op: "unsubscribe", deviceId: previousStream }).catch(() => {});
      if (connected && previous)
        void client.request({ op: "logs.stop", deviceId: previous }).catch(() => {});
      selected = select.value;
      attachSelected();
    }
    state = snapshot.states.find((entry) => entry.device.id === selected);
    if (state) enabled = state.enabled;
    cancelLeaseTimer?.();
    const stamp = ++leaseTimerEpoch;
    const updateStatus = () => {
      const human = state?.controller === "human";
      const expired = human && (state?.leaseExpiresAt ?? 0) <= options.now();
      const owner = expired
        ? "Control lease expired. Take control again."
        : human
          ? "Human controls input"
          : state?.controller === "agent"
            ? "Agent controls input"
            : "No controller";
      status.textContent = connected
        ? `${state?.lifecycle ?? "idle"} · ${owner}${state?.approved ? " · Approved for thread" : ""}`
        : "Disconnected. Reconnect and take control again.";
    };
    updateStatus();
    if (
      connected &&
      state?.controller === "human" &&
      state.leaseExpiresAt &&
      state.leaseExpiresAt > options.now()
    ) {
      cancelLeaseTimer = options.schedule(
        () => {
          if (destroyed || stamp !== leaseTimerEpoch) return;
          updateStatus();
          refreshButtons();
        },
        Math.min(2147483647, state.leaseExpiresAt - options.now()),
      );
    }
    if (state?.error)
      showError(new DeviceClientError(state.error.code, state.error.message, state.error.hint));
    if (state?.lifecycle !== "live") {
      stream.clear();
      if (subscribed === selected) subscribed = undefined;
    }
    const agents = controlsView.agents;
    const chosenAgent = agents.value;
    agents.replaceChildren();
    for (const agent of options.agents().slice(0, 64)) {
      const option = doc.createElement("option");
      option.value = agent.id;
      option.textContent = agent.name;
      agents.append(option);
    }
    if ([...agents.options].some((option) => option.value === chosenAgent))
      agents.value = chosenAgent;
    refreshButtons();
    // Viewing is safe to restore. Control and approval always require a user command.
    if (connected && state?.lifecycle === "live" && !subscribed && subscribing !== selected) {
      const deviceId = selected;
      subscribing = deviceId;
      void run({ op: "subscribe", deviceId })
        .then(() => {
          if (connected && selected === deviceId) subscribed = deviceId;
        })
        .catch(showError)
        .finally(() => {
          if (subscribing === deviceId) subscribing = undefined;
        });
    }
    if (connected && !seenConnected) {
      seenConnected = true;
      void (async () => {
        await run({ op: "list" });
        await run({ op: "states" });
      })().catch(showError);
    }
  });
  refreshButtons();
  return () => {
    destroyed = true;
    cancelLeaseTimer?.();
    unwatch();
    releaseFrames?.();
    releaseLogs?.();
    stream.clear();
    panel.remove();
    if (connected) {
      if (subscribed)
        void client.request({ op: "unsubscribe", deviceId: subscribed }).catch(() => {});
      if (selected) void client.request({ op: "logs.stop", deviceId: selected }).catch(() => {});
    }
  };
}
