/**
 * The shared libraries Chromium links against on Linux, and the package that provides each on
 * the distributions ace supports (ADR 0093): Ubuntu 24.04+, Debian 12+, Fedora and Arch
 * (Omarchy). Pure: the caller reads `/etc/os-release` and runs the loader. Package names follow
 * each distribution's own repositories (Debian/Ubuntu `apt`, Fedora `dnf`, Arch `pacman`).
 * Ubuntu 24.04+ and Debian 13+ renamed several libraries for 64-bit time (`libasound2t64`, ...);
 * Debian 12 keeps the old names, so it is its own family.
 */
export type LinuxFamily = "debian" | "debian-t64" | "fedora" | "arch";
/** The supported Debian release from before the 64-bit time rename. */
const preT64 = new Set(["bookworm"]);
/** Sonames whose Debian package gained a `t64` suffix. */
const renamedT64 = new Set([
  "libasound.so.2",
  "libglib-2.0.so.0",
  "libgobject-2.0.so.0",
  "libgio-2.0.so.0",
  "libatk-1.0.so.0",
  "libatk-bridge-2.0.so.0",
  "libatspi.so.0",
  "libcups.so.2",
]);

// soname: [debian, fedora, arch]
const packages: Record<string, readonly [string, string, string]> = {
  "libnss3.so": ["libnss3", "nss", "nss"],
  "libnssutil3.so": ["libnss3", "nss-util", "nss"],
  "libsmime3.so": ["libnss3", "nss", "nss"],
  "libnspr4.so": ["libnspr4", "nspr", "nspr"],
  "libplc4.so": ["libnspr4", "nspr", "nspr"],
  "libplds4.so": ["libnspr4", "nspr", "nspr"],
  "libatk-1.0.so.0": ["libatk1.0-0", "atk", "at-spi2-core"],
  "libatk-bridge-2.0.so.0": ["libatk-bridge2.0-0", "at-spi2-atk", "at-spi2-core"],
  "libatspi.so.0": ["libatspi2.0-0", "at-spi2-core", "at-spi2-core"],
  "libcups.so.2": ["libcups2", "cups-libs", "libcups"],
  "libdrm.so.2": ["libdrm2", "libdrm", "libdrm"],
  "libgbm.so.1": ["libgbm1", "mesa-libgbm", "mesa"],
  "libxkbcommon.so.0": ["libxkbcommon0", "libxkbcommon", "libxkbcommon"],
  "libX11.so.6": ["libx11-6", "libX11", "libx11"],
  "libxcb.so.1": ["libxcb1", "libxcb", "libxcb"],
  "libXcomposite.so.1": ["libxcomposite1", "libXcomposite", "libxcomposite"],
  "libXdamage.so.1": ["libxdamage1", "libXdamage", "libxdamage"],
  "libXext.so.6": ["libxext6", "libXext", "libxext"],
  "libXfixes.so.3": ["libxfixes3", "libXfixes", "libxfixes"],
  "libXrandr.so.2": ["libxrandr2", "libXrandr", "libxrandr"],
  "libxshmfence.so.1": ["libxshmfence1", "libxshmfence", "libxshmfence"],
  "libpango-1.0.so.0": ["libpango-1.0-0", "pango", "pango"],
  "libcairo.so.2": ["libcairo2", "cairo", "cairo"],
  "libasound.so.2": ["libasound2", "alsa-lib", "alsa-lib"],
  "libexpat.so.1": ["libexpat1", "expat", "expat"],
  "libglib-2.0.so.0": ["libglib2.0-0", "glib2", "glib2"],
  "libgobject-2.0.so.0": ["libglib2.0-0", "glib2", "glib2"],
  "libgio-2.0.so.0": ["libglib2.0-0", "glib2", "glib2"],
  "libdbus-1.so.3": ["libdbus-1-3", "dbus-libs", "dbus"],
  "libudev.so.1": ["libudev1", "systemd-libs", "systemd-libs"],
};
const column: Record<LinuxFamily, 0 | 1 | 2> = {
  debian: 0,
  "debian-t64": 0,
  fedora: 1,
  arch: 2,
};
const installer: Record<LinuxFamily, string> = {
  debian: "sudo apt-get install -y",
  "debian-t64": "sudo apt-get install -y",
  fedora: "sudo dnf install -y",
  arch: "sudo pacman -S --needed",
};

/** The distribution family from `/etc/os-release` (`ID`, then `ID_LIKE`); undefined if unknown. */
export function linuxFamily(osRelease: string): LinuxFamily | undefined {
  const field = (name: string) =>
    new RegExp(`^${name}=("?)([^"\\n]*)\\1\\s*$`, "m").exec(osRelease)?.[2]?.toLowerCase() ?? "";
  for (const id of [field("ID"), ...field("ID_LIKE").split(/\s+/)]) {
    if (["debian", "ubuntu"].includes(id)) {
      // Derivatives (Mint, Pop!_OS, LMDE) name the Ubuntu or Debian release they build on.
      const codename =
        field("UBUNTU_CODENAME") || field("DEBIAN_CODENAME") || field("VERSION_CODENAME");
      if (codename) return preT64.has(codename) ? "debian" : "debian-t64";
      const version = Number.parseFloat(field("VERSION_ID"));
      const old = field("ID") === "ubuntu" ? version < 24.04 : version < 13;
      return Number.isFinite(version) && old ? "debian" : "debian-t64";
    }
    if (id === "fedora") return "fedora";
    if (["arch", "archlinux"].includes(id)) return "arch";
  }
  return undefined;
}

/** Sonames the dynamic loader could not find, from its error text or `ldd` output. */
export function missingLibraries(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/error while loading shared libraries: ([^\s:]+):/g))
    if (match[1]) found.add(match[1]);
  for (const match of text.matchAll(/^\s*(\S+) => not found\s*$/gm))
    if (match[1]) found.add(match[1]);
  return [...found].slice(0, 64);
}

/** The command that installs the packages providing `libraries`, or undefined if none is known. */
export function libraryInstallCommand(
  libraries: readonly string[],
  family: LinuxFamily | undefined,
): string | undefined {
  if (!family) return undefined;
  const names = new Set<string>();
  for (const library of libraries) {
    const name = packages[library]?.[column[family]];
    if (name) names.add(family === "debian-t64" && renamedT64.has(library) ? `${name}t64` : name);
  }
  return names.size ? `${installer[family]} ${[...names].join(" ")}` : undefined;
}
