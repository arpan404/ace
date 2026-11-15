import type { MediaCapabilityEntry } from "./acceleration.ts";
import table from "./picture-encoders.json" with { type: "json" };

/**
 * The codecs ace-media can encode pictures in (JPEG sources: screencast tabs and "Use my
 * Chrome") on this machine. Two things decide it: what the probe saw work (A1's capability
 * list), and what ace-media's JPEG encoder can build on this platform. That second part is
 * `picture-encoders.json`, the same table as `encode::platform::BUILT_ENCODERS` in ace-media,
 * whose test checks the two agree. A backend the probe found but ace-media can't build there
 * (VA-API, Media Foundation or NVENC today) is never offered, so the daemon never asks for an
 * encode that ace-media would refuse.
 */

const families = ["avc1", "hvc1"] as const;
const built: Readonly<Record<string, readonly string[] | undefined>> = table;

/** The hardware encoders ace-media builds for pictures on `platform` (a Node platform name). */
export function pictureEncoders(platform: string): readonly string[] {
  return Object.hasOwn(built, platform) ? (built[platform] ?? []) : [];
}

/**
 * The codecs to offer, best first: each family a working hardware encoder ace-media builds
 * here covers, and H.264 from the last-resort encoder. H.264 first, since every viewer decodes
 * it. Empty before the probe's result.
 */
export function pictureCodecs(
  capabilities: readonly MediaCapabilityEntry[],
  encoders: readonly string[],
): string[] {
  const codecs: string[] = [];
  for (const entry of capabilities) {
    if (entry.step !== "encode" || entry.state !== "ok" || !entry.codec) continue;
    const family = families.find((f) => entry.codec?.startsWith(f));
    if (!family) continue;
    const usable =
      entry.backend === "chrome"
        ? family === "avc1"
        : entry.hardware && encoders.includes(entry.backend);
    if (usable && !codecs.some((codec) => codec.startsWith(family))) codecs.push(entry.codec);
  }
  return codecs.toSorted((a, b) => Number(b.startsWith("avc1")) - Number(a.startsWith("avc1")));
}
