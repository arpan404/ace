import { expect, test } from "vitest";
import {
  panelFaulted,
  panelInit,
  panelMayAct,
  panelPonged,
  panelStallMs,
  panelTick,
  panelUrl,
  panelWatch,
  readPanelMessage,
  visualizationUrl,
  type PanelWatch,
} from "./index.ts";

/*
 * A package panel's channel on the host (ADR 0200 §5.2): typed messages only, an action only when
 * its panel declares it, the person's theme in, and a page that throws or stalls three times is
 * stopped. The page itself runs in the same sandbox as a chat visualization.
 */

const declared = new Set(["stop_watching"]);

test("only typed messages, and only declared actions, are read from a page", () => {
  expect(
    readPanelMessage({ type: "ace.panel.action", name: "stop_watching", value: "KTM" }, declared),
  ).toEqual({ type: "ace.panel.action", name: "stop_watching", value: "KTM" });
  expect(readPanelMessage({ type: "ace.panel.action", name: "book_it" }, declared)).toBeUndefined();
  expect(
    readPanelMessage({ type: "ace.panel.action", name: "stop_watching", extra: 1 }, declared),
  ).toBeUndefined();
  for (const other of [
    { type: "ace.panel.call", tool: "send_message" },
    { type: "ace.panel.open", url: "https://example.com" },
    { type: "ace.html.height", height: 1e9 },
    "ace.panel.action",
    null,
  ])
    expect(readPanelMessage(other, declared)).toBeUndefined();
  expect(readPanelMessage({ type: "ace.html.height", height: 320 }, declared)).toEqual({
    type: "ace.html.height",
    height: 320,
  });
});

test("the person's theme crosses in on init, with nothing that can leave a CSS value", () => {
  const init = panelInit(
    { colorScheme: "light", foreground: "rgb(20,20,20)", accent: "red;}body{x:y" },
    true,
    { width: 360.4, height: 700 },
  );
  expect(init).toEqual({
    type: "ace.panel.init",
    runtime: "1",
    tokens: { foreground: "rgb(20,20,20)" },
    scheme: "light",
    reduceMotion: true,
    size: { width: 360, height: 700 },
  });
});

const ticked = (watch: PanelWatch, at: number) => panelTick(watch, at).watch;

test("a page that throws or stalls three times is stopped", () => {
  let watch = panelFaulted(panelFaulted(panelWatch));
  expect(watch.stopped).toBe(false);
  // A ping answered in time is no strike.
  const pinged = panelTick(watch, 0);
  expect(pinged.ping).toBe(1);
  watch = panelPonged(pinged.watch, 1);
  watch = ticked(watch, 10);
  // Unanswered past the stall time: the third strike.
  expect(ticked(watch, 10 + panelStallMs - 1).stopped).toBe(false);
  watch = ticked(watch, 10 + panelStallMs);
  expect(watch).toMatchObject({ strikes: 3, stopped: true });
  expect(panelTick(watch, 99_999).ping).toBeUndefined();
});

test("a page can't flood its bot: actions past the budget are dropped", () => {
  let watch = panelWatch;
  const sent: boolean[] = [];
  for (let i = 0; i < 10; i++) {
    const asked = panelMayAct(watch, i * 100);
    watch = asked.watch;
    sent.push(asked.ok);
  }
  expect(sent.filter(Boolean)).toHaveLength(8);
  expect(panelMayAct(watch, 20_000).ok).toBe(true);
});

/** The page the outer document frames, as the browser receives it. */
const framed = (url: string) => {
  const outer = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  return { outer, page: /srcdoc="([^"]*)"/.exec(outer)?.[1]?.replaceAll("&quot;", '"') ?? "" };
};

/** A document's CSP. */
const policy = (text: string) => /Content-Security-Policy" content="([^"]*)"/.exec(text)?.[1];

test("a panel's page runs in the visualization sandbox, with the panel's channel", () => {
  const html = "<!doctype html><html><head></head><body><p>Trips</p></body></html>";
  const panel = framed(panelUrl(html, { colorScheme: "dark" }));
  const visual = framed(visualizationUrl(html, { colorScheme: "dark" }, "interactive", 2));
  expect(panel.outer).toContain('sandbox="allow-scripts"');
  expect(panel.outer).not.toContain("allow-same-origin");
  expect(policy(panel.outer)).toBe(policy(visual.outer));
  expect(policy(panel.page)).toBe(policy(visual.page));
  expect(policy(panel.page)).toContain("default-src 'none'");
  expect(panel.page).toContain("acePanel");
  expect(visual.page).not.toContain("acePanel");
});
