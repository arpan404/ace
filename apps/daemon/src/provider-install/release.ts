import { z } from "zod";
import type { Installer } from "@ace/provider-kit/installers";

/*
 * Pure facts about a published release: what the registry says the newest version is, which
 * package carries this computer's binary, and which Homebrew name an installed binary came from.
 */

export const ReleaseVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

const Manifest = z.object({
  version: ReleaseVersion,
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

export interface Release {
  version: string;
  /** Package name to version or `npm:` alias, as published with that version. */
  optionalDependencies: Readonly<Record<string, string>>;
}

/**
 * A registry reply for one version's `version` and `optionalDependencies`, from npm `view` or
 * Bun `info` with `--json`: a bare version string when the package has no optional
 * dependencies, else an object. Plain version text reads too.
 */
export function parseRelease(raw: string | undefined): Release | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* Plain version text. */
  }
  const bare = ReleaseVersion.safeParse(value);
  if (bare.success) return { version: bare.data, optionalDependencies: {} };
  const manifest = Manifest.safeParse(value);
  if (!manifest.success) return undefined;
  return {
    version: manifest.data.version,
    optionalDependencies: manifest.data.optionalDependencies ?? {},
  };
}

const archNames: Readonly<Record<string, readonly string[]>> = {
  arm64: ["arm64", "aarch64"],
  x64: ["x64"],
};

/**
 * The `name@version` of the package that carries this computer's binary for `release`, when the
 * CLI ships one per platform: `@anthropic-ai/claude-code-darwin-arm64@2.1.321`, or Codex's alias
 * `@openai/codex@0.167.0-darwin-arm64`. Vendors publish these after the main package, so until it
 * exists the release can't install here. Undefined when the CLI has no such package.
 */
export function platformPackage(
  name: string,
  release: Release,
  platform: string,
  arch: string,
): string | undefined {
  const suffixes = (archNames[arch] ?? [arch]).map((cpu) => `${platform}-${cpu}`);
  for (const [dependency, spec] of Object.entries(release.optionalDependencies)) {
    const alias = spec.startsWith("npm:") ? spec.slice(4) : undefined;
    const at = alias ? alias.lastIndexOf("@") : -1;
    const target = alias && at > 0 ? alias.slice(0, at) : dependency;
    const version = alias && at > 0 ? alias.slice(at + 1) : spec;
    if (!ReleaseVersion.safeParse(version).success) continue;
    const ours =
      target === name
        ? suffixes.some((suffix) => version.endsWith(`-${suffix}`))
        : target.startsWith(`${name}-`) && suffixes.includes(target.slice(name.length + 1));
    if (ours) return `${target}@${version}`;
  }
  return undefined;
}

/** The Homebrew name `path` (a resolved binary) was installed under, else the default name. */
export function brewName(spec: Installer, path: string | undefined): string | undefined {
  if (!spec.brew) return undefined;
  const names = [spec.brew.name, ...(spec.brew.alternates ?? [])];
  const normalized = path?.replaceAll("\\", "/") ?? "";
  return (
    names.find((name) => {
      const short = name.split("/").at(-1) ?? name;
      return ["Caskroom", "Cellar"].some((dir) => normalized.includes(`/${dir}/${short}/`));
    }) ?? spec.brew.name
  );
}

const ClaudeChannelSettings = z.object({ autoUpdatesChannel: z.enum(["stable", "latest"]) });
/** Claude Code's `autoUpdatesChannel` in one settings file; undefined when it isn't set. */
export function claudeChannel(settings: string | undefined): "stable" | "latest" | undefined {
  if (!settings) return undefined;
  try {
    const parsed = ClaudeChannelSettings.safeParse(JSON.parse(settings));
    return parsed.success ? parsed.data.autoUpdatesChannel : undefined;
  } catch {
    return undefined;
  }
}
