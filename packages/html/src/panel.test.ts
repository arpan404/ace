import { expect, test } from "vitest";
import {
  panelConfirm,
  panelConfirmArmMs,
  panelConfirmPressed,
  panelFaulted,
  panelInit,
  panelMayAct,
  panelMessageBytes,
  panelMessageFromTitle,
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
 * A package panel's channel on the host (ADR 0200 §5.2): typed messages only, as text of at most
 * 16 KiB of UTF-8; an action only when its panel declares it; the person's theme in; a page that
 * throws or stalls three times is stopped; and an action that needs the person waits on ace's own
 * line, where only a real press sends it. The page itself runs in the same sandbox as a chat
 * visualization.
 */

const declared = new Set(["stop_watching"]);
const read = (message: unknown) => readPanelMessage(JSON.stringify(message), declared);

test("only typed messages, and only declared actions, are read from a page", () => {
  expect(read({ type: "ace.panel.action", name: "stop_watching", value: "KTM" })).toEqual({
    type: "ace.panel.action",
    name: "stop_watching",
    value: "KTM",
  });
  expect(read({ type: "ace.panel.action", name: "book_it" })).toBeUndefined();
  expect(read({ type: "ace.panel.action", name: "stop_watching", extra: 1 })).toBeUndefined();
  for (const other of [
    { type: "ace.panel.call", tool: "send_message" },
    { type: "ace.panel.open", url: "https://example.com" },
    { type: "ace.html.height", height: 1e9 },
    "ace.panel.action",
    null,
  ])
    expect(read(other)).toBeUndefined();
  expect(read({ type: "ace.html.height", height: 320 })).toEqual({
    type: "ace.html.height",
    height: 320,
  });
  // The bridges relay text only: a message as an object is never read.
  expect(
    readPanelMessage({ type: "ace.panel.action", name: "stop_watching", value: "KTM" }, declared),
  ).toBeUndefined();
  expect(readPanelMessage("{not json", declared)).toBeUndefined();
});

/** An action whose JSON text is `bytes` long in UTF-8, its value made of `unit`. */
function actionOf(unit: string, bytes: number): string {
  const shell = JSON.stringify({ type: "ace.panel.action", name: "stop_watching", value: "" });
  const size = new TextEncoder().encode(unit).length;
  return shell.replace('""', `"${unit.repeat(Math.floor((bytes - shell.length) / size))}"`);
}
const utf8 = (text: string) => new TextEncoder().encode(text).length;

test("a message over 16 KiB of UTF-8 is dropped, however few UTF-16 units it takes", () => {
  expect(panelMessageBytes).toBe(16 * 1024);
  // ASCII at the bound goes; one byte over doesn't.
  const atBound = actionOf("a", panelMessageBytes);
  expect(utf8(atBound)).toBe(panelMessageBytes);
  expect(readPanelMessage(atBound, declared)?.type).toBe("ace.panel.action");
  expect(readPanelMessage(atBound.replace('"a', '"aa'), declared)).toBeUndefined();
  // Far over: refused on its length.
  expect(readPanelMessage(actionOf("a", 4 * 1024 * 1024), declared)).toBeUndefined();
  // Three bytes a unit: under 16 KiB of units, near 48 KiB of bytes.
  const euros = actionOf("€", 3 * panelMessageBytes - 300);
  expect(euros.length).toBeLessThan(panelMessageBytes);
  expect(readPanelMessage(euros, declared)).toBeUndefined();
  // Pairs are four bytes in two units, and a lone surrogate is three; the bound is the bytes.
  for (const unit of ["€", "😀", "é", "\ud800", "\udc00x"]) {
    for (const bytes of [panelMessageBytes - 3, panelMessageBytes + 3]) {
      const text = actionOf(unit, bytes);
      const fits = utf8(text) <= panelMessageBytes;
      expect(readPanelMessage(text, declared) !== undefined, `${unit} ${bytes}`).toBe(fits);
    }
  }
});

test("a desktop panel's title carries the text, held to the same bound", () => {
  const small = JSON.stringify({ type: "ace.panel.pong", n: 3 });
  expect(panelMessageFromTitle(`ace.panel:7:${small}`)).toBe(small);
  expect(panelMessageFromTitle(`ace.panel:x:${small}`)).toBeUndefined();
  expect(panelMessageFromTitle(`ace.panel:8:${actionOf("€", 3 * panelMessageBytes - 300)}`)).toBe(
    undefined,
  );
  const atBound = actionOf("a", panelMessageBytes);
  expect(panelMessageFromTitle(`ace.panel:9:${atBound}`)).toBe(atBound);
});

test("ace's own confirm line says what goes and takes only a real press, once it has shown", () => {
  const line = panelConfirm(
    "Watched trips",
    { name: "book_fare", label: "Book this fare" },
    "KTM-DEL",
    1000,
  );
  expect(line.words).toBe("Watched trips asks to send “Book this fare” with KTM-DEL.");
  expect(
    panelConfirm("Watched trips", { name: "check_now", label: "Check now" }, undefined, 0).words,
  ).toBe("Watched trips asks to send “Check now”.");
  expect(
    panelConfirm("Trips", { name: "pick", label: "Pick" }, { seat: "12A", cabin: "economy" }, 0)
      .words,
  ).toBe('Trips asks to send “Pick” with {"seat":"12A","cabin":"economy"}.');
  const long = panelConfirm("Trips", { name: "note", label: "Note" }, "x ".repeat(200), 0).words;
  expect(long.length).toBeLessThan(120);
  expect(long.endsWith("….")).toBe(true);
  const armed = 1000 + panelConfirmArmMs;
  for (const [trusted, at, sends] of [
    // A script's click, whenever it comes.
    [false, armed + 5000, false],
    // A real press too soon after the line appeared: perhaps meant for the page under it.
    [true, 1000, false],
    [true, armed - 1, false],
    [true, armed, true],
  ] as const)
    expect(panelConfirmPressed({ trusted, at }, line), `${trusted} ${at}`).toBe(sends);
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
