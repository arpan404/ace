import type { ForgeMediaRequest, ForgeMediaResult } from "@ace/protocol";
import { clipWebm } from "./forge-media-clip.ts";

/*
 * The media in the fake's rich pull request and issue (`rich-content.ts`), as the daemon would
 * resolve it (ADR 0096): pictures drawn as SVG, a short WebM for an uploaded recording, a plain
 * link that isn't media, and an attachment GitHub no longer has. Bytes are read by hash with
 * `forge.media.download`.
 */

const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;
export const media = {
  before: asset("1b5f0c1e-6a2f-4e8b-9c11-0a7d3e5f2b41"),
  after: asset("2c6a1d2f-7b3e-4f9c-8d22-1b8e4f6a3c52"),
  recording: asset("3d7b2e3a-8c4f-4a0d-9e33-2c9f5a7b4d63"),
  missing: asset("4e8c3f4b-9d5a-4b1e-8f44-3d0a6b8c5e74"),
  diagram: "https://user-images.githubusercontent.com/4412/diagram-flow.png",
  logoLight: "https://raw.githubusercontent.com/acme/ace/main/docs/logo-light.svg",
  logoDark: "https://raw.githubusercontent.com/acme/ace/main/docs/logo-dark.svg",
  badge: "https://img.shields.io/badge/coverage-92%25-informational",
  notes: "https://example.com/release-notes",
};

const svg = (width: number, height: number, body: string) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, Segoe UI, sans-serif">${body}</svg>`,
  );

/** A screenshot of a settings window: `tone` light or dark, `label` what changed. */
function screenshot(tone: "light" | "dark", label: string) {
  const bg = tone === "light" ? "#f6f7f9" : "#16181d";
  const card = tone === "light" ? "#ffffff" : "#20232a";
  const ink = tone === "light" ? "#1d2129" : "#e6e8ec";
  const muted = tone === "light" ? "#8a919e" : "#7d8593";
  const rows = Array.from(
    { length: 6 },
    (_, i) =>
      `<rect x="420" y="${200 + i * 92}" width="1040" height="64" rx="10" fill="${card}"/>` +
      `<rect x="452" y="${222 + i * 92}" width="${240 + ((i * 97) % 260)}" height="20" rx="6" fill="${muted}" opacity=".55"/>` +
      `<rect x="1340" y="${218 + i * 92}" width="88" height="28" rx="14" fill="${i === 2 ? "#3b82f6" : muted}" opacity="${i === 2 ? 1 : 0.35}"/>`,
  ).join("");
  return svg(
    1600,
    900,
    `<rect width="1600" height="900" fill="${bg}"/>` +
      `<rect x="0" y="0" width="360" height="900" fill="${card}"/>` +
      Array.from(
        { length: 9 },
        (_, i) =>
          `<rect x="32" y="${96 + i * 56}" width="${180 + ((i * 53) % 90)}" height="18" rx="6" fill="${muted}" opacity=".45"/>`,
      ).join("") +
      `<text x="420" y="140" font-size="44" font-weight="600" fill="${ink}">${label}</text>` +
      rows,
  );
}

const diagram = svg(
  1280,
  480,
  `<rect width="1280" height="480" fill="#eef2f7"/>` +
    ["Client", "Daemon", "gh", "GitHub"]
      .map(
        (name, i) =>
          `<rect x="${60 + i * 300}" y="180" width="220" height="120" rx="16" fill="#ffffff" stroke="#94a3b8" stroke-width="3"/>` +
          `<text x="${170 + i * 300}" y="252" font-size="34" text-anchor="middle" fill="#1e293b">${name}</text>` +
          (i < 3
            ? `<path d="M${282 + i * 300} 240 h70" stroke="#64748b" stroke-width="4" marker-end="url(#a)"/>`
            : ""),
      )
      .join("") +
    `<defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#64748b"/></marker></defs>`,
);

const logo = (tone: "light" | "dark") =>
  svg(
    480,
    120,
    `<rect width="480" height="120" rx="20" fill="${tone === "light" ? "#ffffff" : "#0f1115"}"/>` +
      `<circle cx="70" cy="60" r="30" fill="${tone === "light" ? "#111827" : "#f9fafb"}"/>` +
      `<text x="124" y="76" font-size="44" font-weight="700" fill="${tone === "light" ? "#111827" : "#f9fafb"}">ace · ${tone}</text>`,
  );

const badge = svg(
  150,
  20,
  `<rect width="150" height="20" rx="3" fill="#555"/><rect x="72" width="78" height="20" rx="3" fill="#007ec6"/><text x="36" y="14" font-size="11" fill="#fff" text-anchor="middle">coverage</text><text x="110" y="14" font-size="11" fill="#fff" text-anchor="middle">92%</text>`,
);

const decode = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

type Entry =
  | {
      kind: "image" | "video";
      mimeType: string;
      bytes: Uint8Array;
      width?: number;
      height?: number;
    }
  | ForgeMediaResult;

let table: Map<string, Entry> | undefined;
/** Media by URL, made on first use. */
function entries(): Map<string, Entry> {
  table ??= new Map<string, Entry>([
    [
      media.before,
      {
        kind: "image",
        mimeType: "image/svg+xml",
        bytes: screenshot("light", "Before: one long form"),
        width: 1600,
        height: 900,
      },
    ],
    [
      media.after,
      {
        kind: "image",
        mimeType: "image/svg+xml",
        bytes: screenshot("dark", "After: grouped settings"),
        width: 1600,
        height: 900,
      },
    ],
    [
      media.diagram,
      { kind: "image", mimeType: "image/svg+xml", bytes: diagram, width: 1280, height: 480 },
    ],
    [
      media.logoLight,
      { kind: "image", mimeType: "image/svg+xml", bytes: logo("light"), width: 480, height: 120 },
    ],
    [
      media.logoDark,
      { kind: "image", mimeType: "image/svg+xml", bytes: logo("dark"), width: 480, height: 120 },
    ],
    [
      media.badge,
      { kind: "image", mimeType: "image/svg+xml", bytes: badge, width: 150, height: 20 },
    ],
    [media.recording, { kind: "video", mimeType: "video/webm", bytes: decode(clipWebm) }],
    [media.missing, { state: "unavailable", reason: "not_found" }],
    [media.notes, { state: "none" }],
  ]);
  return table;
}

/** A stable hash-shaped name for the `index`th file (the fake doesn't hash). */
const nameOf = (index: number) => index.toString(16).padStart(64, "c");

/** What the daemon would answer for each item. */
export function resolveFakeMedia(items: readonly ForgeMediaRequest[]): ForgeMediaResult[] {
  const all = [...entries()];
  return items.map((item) => {
    const index = all.findIndex(([url]) => url === item.url);
    const entry = all[index]?.[1];
    if (!entry)
      return item.role === "link"
        ? { state: "none" }
        : { state: "unavailable", reason: "not_found" };
    if ("state" in entry) return entry;
    return {
      state: "ready",
      kind: entry.kind,
      sha256: nameOf(index),
      mimeType: entry.mimeType,
      bytes: entry.bytes.length,
      ...(entry.width && entry.height ? { width: entry.width, height: entry.height } : {}),
    };
  });
}

/** The bytes of a resolved file, by the name `resolveFakeMedia` gave it. */
export function fakeMediaBytes(sha256: string): Uint8Array | undefined {
  const index = [...entries()].findIndex((_, at) => nameOf(at) === sha256);
  const entry = index >= 0 ? [...entries()][index]?.[1] : undefined;
  return entry && !("state" in entry) ? entry.bytes : undefined;
}
