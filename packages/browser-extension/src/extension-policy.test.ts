import { expect, test } from "vitest";
import { cdpAllowed, pageAllowed, unrelayableFrame } from "../extension/policy.ts";
import { browserFamily } from "../extension/identity.ts";
import { extensionId, extensionIdFor } from "./extension-id.ts";

test("controlled tabs may show web pages and the blank page, never browser or extension pages", () => {
  for (const url of ["https://example.com/a?b", "http://127.0.0.1:3000/", "about:blank"])
    expect(pageAllowed(url)).toBe(true);
  for (const url of [
    "chrome://settings",
    "chrome://password-manager/passwords",
    "edge://settings",
    "brave://wallet",
    "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/popup.html",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "not a url",
  ])
    expect(pageAllowed(url)).toBe(false);
});

test("the extension stores and password manager sites are refused like browser pages", () => {
  expect(pageAllowed("https://chromewebstore.google.com/detail/x")).toBe(false);
  expect(pageAllowed("https://chrome.google.com/webstore/category")).toBe(false);
  expect(pageAllowed("https://passwords.google.com/")).toBe(false);
  expect(pageAllowed("https://microsoftedge.microsoft.com/addons/detail/x")).toBe(false);
  // Only the store path is sensitive on a shared host.
  expect(pageAllowed("https://chrome.google.com/intl/en/chrome/")).toBe(true);
});

test("CDP from ace reaches page automation domains but never cookies or browser-wide state", () => {
  for (const method of [
    "Page.navigate",
    "Runtime.evaluate",
    "DOM.getDocument",
    "Accessibility.getFullAXTree",
    "Input.dispatchMouseEvent",
    "Network.getResponseBody",
  ])
    expect(cdpAllowed(method)).toBe(true);
  for (const method of [
    "Network.getCookies",
    "Network.getAllCookies",
    "Network.setCookie",
    "Network.clearBrowserCookies",
    "Storage.getCookies",
    "DOMStorage.getDOMStorageItems",
    "IndexedDB.requestData",
    "Target.createTarget",
    "Browser.close",
    "Fetch.enable",
  ])
    expect(cdpAllowed(method)).toBe(false);
});

test("the extension id is derived from its public key the way Chrome derives it", () => {
  // Chrome reported this id for this key when the Phase 0 spike loaded a keyed extension.
  expect(
    extensionIdFor(
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqe5z4Be7d1zY8Dhnfyuh4HurzgKq/d2HqMQK+aoT1mJInoknx2QWrgHPBo9PXU5mPY7uWe/31Y/w4mclxV5+xZK32eZkLbTgoYLjuI2b92dvZmgjo/QwquoswZbJKg8gCAOOygvlmn/K6qQ/uCw0Am05bygwn9+bZkk6ByGjA0bojky5ZYjpj0abgOYJ5/nX1AG2fnU9bI4aeBacG0X77Z9/HeUlhYk4X9jglnZdYzCCwEqAT45V36YXrurMurMLI7/68dVMHSU417xa72UalPgRAHadtos+knf1ii0JpG7EWzkafM6J1ed3IFYAXHIY8kMCMvOx+1gR/DM5qQAdGwIDAQAB",
    ),
  ).toBe("ppjlceadilgkcbccjldfdghmmanfgbjn");
  expect(extensionId).toBe("colganbkmbpfajldlcclkcmpeoicoaka");
});

test("the browser is named from its own brand, not the Chromium brand every fork carries", () => {
  const chromium = { brand: "Chromium", version: "155" };
  expect(browserFamily([chromium, { brand: "Microsoft Edge", version: "155" }]).family).toBe(
    "edge",
  );
  expect(browserFamily([{ brand: "Google Chrome", version: "155" }, chromium])).toEqual({
    family: "chrome",
    version: "155",
  });
  expect(browserFamily([chromium]).family).toBe("chromium");
  expect(browserFamily([]).family).toBe("other");
});

const frame = (bytes: number) => ({ sessionId: 3, data: "A".repeat(bytes), metadata: {} });
test("a screencast picture the relay can't carry is acknowledged in the browser; one that fits goes to ace", () => {
  expect(unrelayableFrame("Page.screencastFrame", frame(1024 * 1024))).toBe(3);
  expect(unrelayableFrame("Page.screencastFrame", frame(300 * 1024))).toBeUndefined();
  // Other large events are the host's to refuse; nothing in the browser waits on them.
  expect(unrelayableFrame("Network.dataReceived", frame(1024 * 1024))).toBeUndefined();
});
