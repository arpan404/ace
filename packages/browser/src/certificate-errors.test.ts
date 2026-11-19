import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { certificateErrors } from "./certificate-errors.ts";

/** A tab's CDP events as Chromium sends them when a document's certificate is refused. */
function tab() {
  const events = new EventEmitter();
  const cdp = {
    send: async () => ({}),
    on: (method: string, listener: (params: unknown) => void) => events.on(method, listener),
    off: (method: string, listener: (params: unknown) => void) => events.off(method, listener),
  };
  const certificates = certificateErrors(cdp, () => {});
  const commit = (url: string) =>
    events.emit("Page.frameNavigated", { frame: { id: "main", url } });
  return {
    certificates,
    commit,
    refuse(url: string, requestId: string) {
      events.emit("Network.requestWillBeSent", {
        requestId,
        frameId: "main",
        type: "Document",
        request: { url },
      });
      events.emit("Network.loadingFailed", {
        requestId,
        errorText: "net::ERR_CERT_AUTHORITY_INVALID",
      });
    },
  };
}

const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

test("a proceed waits for the warning page, which commits after the load fails", async () => {
  const t = tab();
  t.commit("about:blank");
  t.refuse("https://dev.local/app", "1");
  // The person already sees the error, but the warning page that can proceed isn't there yet.
  expect(t.certificates.read()?.url).toBe("https://dev.local/app");
  const shown = t.certificates.shown("https://dev.local/app");
  expect(await settled(shown)).toBe(false);
  t.commit("chrome-error://chromewebdata/");
  await expect(shown).resolves.toEqual({
    url: "https://dev.local/app",
    error: "ERR_CERT_AUTHORITY_INVALID",
  });
});

test("a second refused address waits for its own warning page, not the one still shown", async () => {
  const t = tab();
  t.refuse("https://dev.local/one", "1");
  t.commit("chrome-error://chromewebdata/");
  t.refuse("https://dev.local/two", "2");
  const shown = t.certificates.shown("https://dev.local/two");
  expect(await settled(shown)).toBe(false);
  t.commit("chrome-error://chromewebdata/");
  await expect(shown).resolves.toMatchObject({ url: "https://dev.local/two" });
});

test("a proceed for a page the tab no longer shows is refused", async () => {
  const t = tab();
  t.refuse("https://dev.local/app", "1");
  const shown = t.certificates.shown("https://dev.local/app");
  t.commit("https://elsewhere.local/");
  await expect(shown).rejects.toThrow(/no longer shown/);
  await expect(t.certificates.shown("https://dev.local/app")).rejects.toThrow(/no longer shown/);
});

test("closing the tab ends a proceed that is still waiting", async () => {
  const t = tab();
  t.refuse("https://dev.local/app", "1");
  const shown = t.certificates.shown("https://dev.local/app");
  t.certificates.close();
  await expect(shown).rejects.toThrow(/no longer shown/);
});
