import type { MarketScanFinding } from "@ace/protocol/marketplace";
import { isSceneFile } from "@ace/suits";
import type { ArchiveFile } from "../archive.ts";
import { text as decodeText } from "../listing.ts";
import { normaliseText } from "./text.ts";

/*
 * The `scene` check (ADR 0173 §8): a Suit's scene JS draws, nothing more. It never reaches the
 * network, spawns a worker, shares memory, runs built strings, reaches its parent frame or loops
 * without yielding. Each disallowed capability is a finding with its line. Pure, a token scan over
 * the scene's NFKC-normalised text; the live pixel check runs on the device. A scene has no module
 * system or input, so a plain name match is enough to refuse it for review.
 */

interface Pattern {
  rule: string;
  pattern: RegExp;
  message: string;
  level: MarketScanFinding["level"];
}

const PATTERNS: readonly Pattern[] = [
  { rule: "scene-fetch", pattern: /\bfetch\s*\(/, message: "calls fetch", level: "block" },
  {
    rule: "scene-xhr",
    pattern: /\bXMLHttpRequest\b/,
    message: "uses XMLHttpRequest",
    level: "block",
  },
  {
    rule: "scene-websocket",
    pattern: /\bWebSocket\b/,
    message: "opens a WebSocket",
    level: "block",
  },
  {
    rule: "scene-eventsource",
    pattern: /\bEventSource\b/,
    message: "opens an EventSource",
    level: "block",
  },
  {
    rule: "scene-beacon",
    pattern: /\bsendBeacon\s*\(/,
    message: "calls sendBeacon",
    level: "block",
  },
  {
    rule: "scene-rtc",
    pattern: /\bRTCPeerConnection\b/,
    message: "opens an RTCPeerConnection",
    level: "block",
  },
  {
    rule: "scene-remote-url",
    pattern: /["'`]https?:\/\//,
    message: "names a remote URL",
    level: "block",
  },
  {
    rule: "scene-dynamic-import",
    pattern: /\bimport\s*\(/,
    message: "imports code dynamically",
    level: "block",
  },
  {
    rule: "scene-worker",
    pattern: /\b(?:Shared)?Worker\s*\(/,
    message: "starts a Worker",
    level: "block",
  },
  {
    rule: "scene-service-worker",
    pattern: /\bserviceWorker\b/,
    message: "reaches a service worker",
    level: "block",
  },
  {
    rule: "scene-shared-memory",
    pattern: /\b(?:SharedArrayBuffer|Atomics)\b/,
    message: "uses shared memory",
    level: "block",
  },
  { rule: "scene-eval", pattern: /\beval\s*\(/, message: "calls eval", level: "block" },
  {
    rule: "scene-function-constructor",
    pattern: /\bnew\s+Function\s*\(/,
    message: "builds a function from a string",
    level: "block",
  },
  {
    rule: "scene-string-timer",
    pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
    message: "runs a string on a timer",
    level: "block",
  },
  { rule: "scene-wasm", pattern: /\bWebAssembly\b/, message: "uses WebAssembly", level: "block" },
  {
    rule: "scene-parent-frame",
    pattern: /\b(?:window\s*\.\s*)?(?:parent|top)\s*\.\s*(?:location|postMessage|document)\b/,
    message: "reaches its parent frame",
    level: "block",
  },
];

/** A `while (true)` or `for (;;)` whose body holds no yield point (await or a frame request). */
function unboundedLoop(text: string): number | undefined {
  const lines = text.split("\n");
  const loop = /\b(?:while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;\s*\))/;
  for (const [index, line] of lines.entries()) {
    if (!loop.test(line)) continue;
    // Look at the next ~40 lines for a yield; a scene loop that never yields hangs the page.
    const window = lines.slice(index, index + 40).join("\n");
    if (!/\b(?:await|requestAnimationFrame|yield)\b/.test(window)) return index + 1;
  }
  return undefined;
}

/** The `scene` check over a Suit's files. */
export function sceneCheck(files: readonly ArchiveFile[]): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];
  for (const file of files) {
    if (!isSceneFile(file.path)) continue;
    const source = decodeText(file.content);
    if (source === undefined) continue;
    const text = normaliseText(source);
    const lines = text.split("\n");
    for (const { rule, pattern, message, level } of PATTERNS) {
      const line = lines.findIndex((l) => pattern.test(l));
      if (line >= 0)
        findings.push({
          check: "scene",
          rule,
          level,
          path: file.path,
          line: line + 1,
          message: `${file.path} line ${line + 1} ${message}; a Suit scene only draws`,
        });
    }
    const loop = unboundedLoop(text);
    if (loop !== undefined)
      findings.push({
        check: "scene",
        rule: "scene-unbounded-loop",
        level: "warn",
        path: file.path,
        line: loop,
        message: `${file.path} line ${loop} loops without yielding, which freezes the page`,
      });
  }
  return findings;
}
