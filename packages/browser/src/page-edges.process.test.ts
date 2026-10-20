import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { executablePath, pageEdges, siteUser } from "./page-edges-test-support.ts";
import { ref } from "./test-support.ts";
import { chromeProcesses } from "./chrome-test-process.ts";

it.skipIf(!executablePath)(
  "a site's sign-in waits for the person, and only their answer reaches the site",
  async () => {
    const f = await pageEdges();
    const held = await f.agent({ action: "navigate", url: `${f.url}/private` });
    expect(held).toMatchObject({
      pending_auth: { origin: f.url, realm: "Fixture members", scheme: "basic" },
      hint: expect.stringContaining("Only the person may sign in"),
    });
    // The tab stays held for the agent until the person answers.
    expect(await f.agent({ action: "snapshot" })).toMatchObject({ pending_auth: {} });
    const [tab] = f.tabs();
    const authId = tab?.pending_auth?.authId;
    expect(authId).toBeDefined();
    await f.person({
      type: "browser.auth.answer",
      tabId: tab?.tabId,
      authId,
      credentials: siteUser,
    });
    await expect.poll(() => f.text(), { timeout: 15_000 }).toContain("Signed in as ada");
    expect(f.tabs()[0]?.pending_auth).toBeUndefined();
  },
  60_000,
);

it.skipIf(!executablePath)(
  "a cancelled sign-in shows the site's refusal and frees the tab",
  async () => {
    const f = await pageEdges();
    await f.agent({ action: "navigate", url: `${f.url}/private` });
    const [tab] = f.tabs();
    await f.person({
      type: "browser.auth.answer",
      tabId: tab?.tabId,
      authId: tab?.pending_auth?.authId,
    });
    await expect.poll(() => f.text(), { timeout: 15_000 }).toContain("Sign-in required");
    expect(f.tabs()[0]?.pending_auth).toBeUndefined();
  },
  60_000,
);

it.skipIf(!executablePath)(
  "the person proceeds past a self-signed certificate for that origin; an agent cannot",
  async () => {
    const f = await pageEdges();
    await expect(f.agent({ action: "navigate", url: `${f.secureUrl}/app` })).rejects.toThrow(
      /ERR_CERT_AUTHORITY_INVALID/,
    );
    const [tab] = f.tabs();
    expect(tab?.certificate_error).toEqual({
      url: `${f.secureUrl}/app`,
      error: "ERR_CERT_AUTHORITY_INVALID",
    });
    // The warning page's own "proceed" is the person's to press, by click or by script.
    await expect(f.agent({ action: "evaluate", expression: "1" })).rejects.toMatchObject({
      code: "needs_person",
    });
    await expect(f.agent({ action: "press", key: "Enter" })).rejects.toMatchObject({
      code: "needs_person",
    });
    await expect(
      f.person({
        type: "browser.certificate.proceed",
        tabId: tab?.tabId,
        url: `${f.secureUrl}/other`,
      }),
    ).rejects.toThrow(/no longer shown/);
    await f.person({
      type: "browser.certificate.proceed",
      tabId: tab?.tabId,
      url: `${f.secureUrl}/app`,
    });
    await expect.poll(() => f.text(), { timeout: 15_000 }).toContain("Secure /app");
    expect(f.tabs()[0]?.certificate_error).toBeUndefined();
    // Remembered for that origin while the browser runs.
    await f.agent({ action: "navigate", url: `${f.secureUrl}/again` });
    expect(await f.text()).toContain("Secure /again");
  },
  60_000,
);

it.skipIf(!executablePath)(
  "an agent's OAuth popup opens as a tab that can post back to its opener",
  async () => {
    const f = await pageEdges();
    await f.agent({ action: "navigate", url: `${f.url}/oauth` });
    const opener = f.tabs()[0]?.tabId;
    const clicked = await f.agent({
      action: "click",
      ref: ref(await f.agent({ action: "snapshot" }), "Sign in with Provider"),
    });
    await expect.poll(() => f.tabs().length, { timeout: 15_000 }).toBe(2);
    const popup = f.tabs().find((tab) => tab.tabId !== opener);
    expect(popup).toMatchObject({ openedBy: { kind: "agent", agentId: "agent-1" } });
    // The agent hears of the window once: in the click's result, or the next one from the opener.
    const next = await f.agent({ action: "navigation_history", tabId: opener });
    expect(
      [clicked, next].filter((result) => JSON.stringify(result).includes("popups_opened")),
    ).toEqual([
      expect.objectContaining({
        popups_opened: [{ tabId: popup?.tabId, url: `${f.url}/consent` }],
      }),
    ]);
    await expect.poll(() => f.text(popup?.tabId), { timeout: 15_000 }).toContain("Allow");
    await f.agent({
      action: "evaluate",
      tabId: popup?.tabId,
      expression: "setTimeout(() => document.querySelector('button').click(), 0)",
    });
    await expect.poll(() => f.text(opener), { timeout: 15_000 }).toContain("token abc123");
    await expect.poll(() => f.tabs().length, { timeout: 15_000 }).toBe(1);
  },
  60_000,
);

it.skipIf(!executablePath)(
  "ace's Chrome never plays a page's sound on the daemon's machine",
  async () => {
    const f = await pageEdges();
    await f.agent({ action: "navigate", url: f.url });
    const { commandLine } = await chromeProcesses(f.home);
    // Sound goes to a fake output device; `--mute-audio` would silence tab capture too.
    expect(commandLine).toContain("--disable-audio-output");
    expect(commandLine).not.toContain("--mute-audio");
  },
  60_000,
);

it.skipIf(!executablePath)(
  "a page's file picker waits for the person's files, which the page then reads",
  async () => {
    const f = await pageEdges();
    await f.agent({ action: "navigate", url: `${f.url}/upload` });
    await f.agent({ action: "click", ref: ref(await f.agent({ action: "snapshot" }), "Avatar") });
    await expect
      .poll(() => f.tabs()[0]?.file_chooser, { timeout: 15_000 })
      .toMatchObject({
        multiple: false,
      });
    const [tab] = f.tabs();
    const sha256 = createHash("sha256").update("hello from my laptop").digest("hex");
    f.attachments.set(sha256, Buffer.from("hello from my laptop"));
    await f.person({
      type: "browser.files.choose",
      tabId: tab?.tabId,
      chooserId: tab?.file_chooser?.chooserId,
      files: [{ sha256, name: "notes.txt" }],
    });
    await expect
      .poll(() => f.text(), { timeout: 15_000 })
      .toContain("picked notes.txt: hello from my laptop");
    expect(f.tabs()[0]?.file_chooser).toBeUndefined();
  },
  60_000,
);

it.skipIf(!executablePath)(
  "an offline page loads by itself once the connection is back",
  async () => {
    const f = await pageEdges();
    await f.agent({ action: "navigate", url: f.url });
    const conditions = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    await f.raw("Network.emulateNetworkConditions", { ...conditions, offline: true });
    await expect(f.agent({ action: "navigate", url: `${f.url}/later` })).rejects.toThrow(
      /ERR_INTERNET_DISCONNECTED/,
    );
    await f.raw("Network.emulateNetworkConditions", { ...conditions, offline: false });
    // Nobody reloads: ace retries the page itself.
    await expect
      .poll(() => f.service.state("thread").loadError, { timeout: 20_000 })
      .toBeUndefined();
    await expect.poll(() => f.text(), { timeout: 20_000 }).toContain("Home page");
  },
  60_000,
);

it.skipIf(!executablePath)(
  "window.print in ace's Chrome saves the page as a PDF for the person",
  async () => {
    const f = await pageEdges();
    await f.agent({ action: "navigate", url: f.url });
    await f.agent({ action: "evaluate", expression: "window.print(), 1" });
    await expect.poll(() => f.artifacts.length, { timeout: 15_000 }).toBe(1);
    const [pdf] = f.artifacts;
    expect(pdf).toMatchObject({ mimeType: "application/pdf", filename: "page.pdf" });
    expect((await readFile(pdf?.path ?? "")).subarray(0, 4).toString()).toBe("%PDF");
  },
  60_000,
);

it.skipIf(!executablePath)(
  "⌘+ and ⌘0 zoom the page in ace's Chrome without reaching it",
  async () => {
    const f = await pageEdges();
    await f.agent({ action: "navigate", url: `${f.url}/keys` });
    const width = Number(await f.agent({ action: "evaluate", expression: "innerWidth" }));
    const chord = (name: string) =>
      f.person({
        type: "browser.input",
        input: { kind: "key", event: "keyDown", key: name, modifiers: 4 },
      });
    await chord("=");
    await expect
      .poll(() => f.agent({ action: "evaluate", expression: "innerWidth" }))
      .toBe(Math.round(width / 1.2));
    await chord("0");
    await expect.poll(() => f.agent({ action: "evaluate", expression: "innerWidth" })).toBe(width);
    expect(await f.agent({ action: "evaluate", expression: "window.keys" })).toBe(0);
  },
  60_000,
);
