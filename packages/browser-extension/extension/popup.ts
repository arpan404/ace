import type { ChromeApi } from "./chrome-api.ts";
import { pageAllowed } from "./policy.ts";
import { decodePopupResponse, type PopupRequest, type PopupState } from "./wire.ts";

declare const chrome: ChromeApi;

const linkWords: Record<string, string> = {
  connected: "Connected to ace",
  connecting: "Connecting to ace…",
  unauthorized: "ace refused this browser. Install again from ace Settings.",
  unavailable: "ace isn't running",
  offline: "Not connected. Install from ace Settings › Computer use.",
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function request(message: PopupRequest) {
  const response = decodePopupResponse(await chrome.runtime.sendMessage(message));
  if (!response) throw new Error("ace for Chrome did not answer");
  if (!response.ok) throw new Error(response.error);
  return response.state;
}

async function render(state: PopupState, problem?: string) {
  const root = document.getElementById("root");
  if (!root) return;
  root.replaceChildren();
  const status = element("p", linkWords[state.link] ?? state.link, "status");
  status.dataset.state = state.link;
  root.append(status);
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current?.id !== undefined) {
    const tabId = current.id;
    const known = state.tabs.find((tab) => tab.tabId === tabId);
    const row = element("div", undefined, "row");
    row.append(element("span", current.title || current.url || "This tab", "title"));
    const allowed = pageAllowed(current.url ?? "");
    const button = element("button", known ? "Stop sharing" : "Share this tab");
    button.disabled = !known && (!allowed || state.link !== "connected");
    if (!allowed) button.title = "ace never works on browser or extension pages";
    button.addEventListener(
      "click",
      () => void update({ kind: known ? "unshare" : "share", tabId }),
    );
    row.append(button);
    root.append(row);
  }
  if (state.tabs.length) {
    const list = element("ul", undefined, "tabs");
    for (const tab of state.tabs) {
      const item = element("li");
      item.append(element("span", tab.title || tab.url, "title"));
      item.append(
        element(
          "span",
          tab.attached ? "Controlled" : tab.access === "agent" ? "Agent" : "Shared",
          "tag",
        ),
      );
      list.append(item);
    }
    root.append(list);
    const stop = element("button", "Stop", "danger");
    stop.addEventListener("click", () => void update({ kind: "stop" }));
    root.append(stop);
  }
  if (problem) root.append(element("p", problem, "problem"));
}

async function update(message: PopupRequest) {
  try {
    await render(await request(message));
  } catch (error) {
    const state = await request({ kind: "state" }).catch((): PopupState => ({
      link: "offline",
      tabs: [],
    }));
    await render(state, error instanceof Error ? error.message : String(error));
  }
}

void update({ kind: "state" });
