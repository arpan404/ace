import * as z from "zod/mini";
import {
  buildText,
  defaultArch,
  isPlatform,
  labelText,
  noteText,
  pickInstaller,
  platformInfo,
  readRelease,
  versionOf,
  type Arch,
  type Platform,
  type Release,
} from "../content/release-pick.ts";
import { repository } from "../site.ts";
import { archOf, platformOf, type ChipHints } from "./visitor.ts";

/*
 * Keeps every download link on the newest release without a rebuild: asks GitHub for the latest
 * release, works out the visitor's system and chip, and re-points the links the build baked in.
 * If GitHub can't be reached or answers with something else, the built links stay as they are.
 *
 * Elements it updates, by data attribute:
 *   a[data-download="mac|windows|linux"]   href, and aria-label when it has one
 *   [data-download-text]                    on such a link: "Download for X" or "Get X builds"
 *   [data-download-note="<platform>"]       "v0.1.0 for macOS on Apple silicon, 228 MB."
 *   [data-download-build="<platform>"]      "macOS on Apple silicon, 228 MB"
 *   [data-release-version]                  "0.1.0"
 *   a[data-release-notes]                   the release page
 */

const cacheKey = "ace-latest-release";
/* One GitHub request per visitor per ten minutes: the unauthenticated limit is 60 an hour. */
const cacheMs = 10 * 60_000;

const cacheSchema = z.object({ at: z.number(), body: z.unknown() });
const hintsSchema = z.object({
  architecture: z.optional(z.string()),
  bitness: z.optional(z.string()),
});

async function latestRelease(): Promise<Release | undefined> {
  try {
    const cached = cacheSchema.safeParse(JSON.parse(sessionStorage.getItem(cacheKey) ?? "null"));
    if (cached.success && Date.now() - cached.data.at < cacheMs)
      return readRelease(cached.data.body);
  } catch {
    // Storage refused or held something unreadable: ask GitHub instead.
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const release = readRelease(body);
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), body }));
    } catch {
      // Private browsing may refuse storage; the next page asks again.
    }
    return release;
  } catch {
    return undefined;
  }
}

/** Chromium's client hints, which tell an Apple-silicon Mac from an Intel one. */
async function chipHints(): Promise<ChipHints | undefined> {
  const data: unknown = Reflect.get(navigator, "userAgentData");
  if (typeof data !== "object" || data === null) return undefined;
  const read: unknown = Reflect.get(data, "getHighEntropyValues");
  if (typeof read !== "function") return undefined;
  try {
    const raw: unknown = await Reflect.apply(read, data, [["architecture", "bitness"]]);
    const parsed = hintsSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `apply` on every element whose `attribute` names a platform. */
function each(
  selector: string,
  attribute: string,
  apply: (el: HTMLElement, platform: Platform) => void,
) {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const platform = element.getAttribute(attribute) ?? undefined;
    if (isPlatform(platform)) apply(element, platform);
  }
}

function update(release: Release, visitor: Platform | undefined, chip: Arch | undefined): void {
  const version = versionOf(release);
  // The visitor's own system gets their chip's build; the others get each system's usual one.
  const archFor = (platform: Platform): Arch =>
    platform === visitor && chip ? chip : defaultArch[platform];

  each("a[data-download]", "data-download", (link, platform) => {
    const arch = archFor(platform);
    const pick = pickInstaller(release, platform, arch);
    link.setAttribute("href", pick.url);
    if (link.hasAttribute("aria-label")) {
      link.setAttribute("aria-label", labelText(version, platform, arch, pick.bytes));
    }
    if (link.hasAttribute("data-download-text")) {
      const { name } = platformInfo[platform];
      link.textContent = pick.bytes ? `Download for ${name}` : `Get ${name} builds`;
    }
  });
  each("[data-download-note]", "data-download-note", (element, platform) => {
    const arch = archFor(platform);
    element.textContent = noteText(
      version,
      platform,
      arch,
      pickInstaller(release, platform, arch).bytes,
    );
  });
  each("[data-download-build]", "data-download-build", (element, platform) => {
    const arch = archFor(platform);
    element.textContent = buildText(platform, arch, pickInstaller(release, platform, arch).bytes);
  });
  for (const element of document.querySelectorAll<HTMLElement>("[data-release-version]")) {
    element.textContent = version;
  }
  for (const link of document.querySelectorAll<HTMLElement>("a[data-release-notes]")) {
    link.setAttribute("href", release.html_url);
  }
}

/** Re-points the page's download links at the newest release for the visitor's computer. */
export async function keepDownloadsCurrent(): Promise<void> {
  const visitor = platformOf(navigator.userAgent);
  const [release, hints] = await Promise.all([latestRelease(), chipHints()]);
  if (!release) return;
  update(release, visitor, archOf(hints, navigator.userAgent));
}
