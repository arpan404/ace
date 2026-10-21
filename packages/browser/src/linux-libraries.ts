/**
 * The shared libraries Chromium links against on Linux, and the package that provides each on
 * the distribution families ace supports. Pure: the caller reads `/etc/os-release` and runs the
 * loader. Package names follow each distribution's own repositories (Debian/Ubuntu `apt`,
 * Fedora/RHEL `dnf`, Arch `pacman`, openSUSE `zypper`). On Ubuntu 24.04+ several Debian names
 * (libasound2, libglib2.0-0, ...) are virtual packages with one `t64` provider, which `apt-get`
 * selects by itself.
 */
export type LinuxFamily = "debian" | "fedora" | "arch" | "suse";

// soname: [debian, fedora, arch, suse]
const packages: Record<string, readonly [string, string, string, string]> = {
  "libnss3.so": ["libnss3", "nss", "nss", "mozilla-nss"],
  "libnssutil3.so": ["libnss3", "nss-util", "nss", "mozilla-nss"],
  "libsmime3.so": ["libnss3", "nss", "nss", "mozilla-nss"],
  "libnspr4.so": ["libnspr4", "nspr", "nspr", "mozilla-nspr"],
  "libplc4.so": ["libnspr4", "nspr", "nspr", "mozilla-nspr"],
  "libplds4.so": ["libnspr4", "nspr", "nspr", "mozilla-nspr"],
  "libatk-1.0.so.0": ["libatk1.0-0", "atk", "at-spi2-core", "libatk-1_0-0"],
  "libatk-bridge-2.0.so.0": [
    "libatk-bridge2.0-0",
    "at-spi2-atk",
    "at-spi2-core",
    "libatk-bridge-2_0-0",
  ],
  "libatspi.so.0": ["libatspi2.0-0", "at-spi2-core", "at-spi2-core", "libatspi0"],
  "libcups.so.2": ["libcups2", "cups-libs", "libcups", "libcups2"],
  "libdrm.so.2": ["libdrm2", "libdrm", "libdrm", "libdrm2"],
  "libgbm.so.1": ["libgbm1", "mesa-libgbm", "mesa", "libgbm1"],
  "libxkbcommon.so.0": ["libxkbcommon0", "libxkbcommon", "libxkbcommon", "libxkbcommon0"],
  "libX11.so.6": ["libx11-6", "libX11", "libx11", "libX11-6"],
  "libxcb.so.1": ["libxcb1", "libxcb", "libxcb", "libxcb1"],
  "libXcomposite.so.1": ["libxcomposite1", "libXcomposite", "libxcomposite", "libXcomposite1"],
  "libXdamage.so.1": ["libxdamage1", "libXdamage", "libxdamage", "libXdamage1"],
  "libXext.so.6": ["libxext6", "libXext", "libxext", "libXext6"],
  "libXfixes.so.3": ["libxfixes3", "libXfixes", "libxfixes", "libXfixes3"],
  "libXrandr.so.2": ["libxrandr2", "libXrandr", "libxrandr", "libXrandr2"],
  "libxshmfence.so.1": ["libxshmfence1", "libxshmfence", "libxshmfence", "libxshmfence1"],
  "libpango-1.0.so.0": ["libpango-1.0-0", "pango", "pango", "libpango-1_0-0"],
  "libcairo.so.2": ["libcairo2", "cairo", "cairo", "libcairo2"],
  "libasound.so.2": ["libasound2", "alsa-lib", "alsa-lib", "libasound2"],
  "libexpat.so.1": ["libexpat1", "expat", "expat", "libexpat1"],
  "libglib-2.0.so.0": ["libglib2.0-0", "glib2", "glib2", "libglib-2_0-0"],
  "libgobject-2.0.so.0": ["libglib2.0-0", "glib2", "glib2", "libgobject-2_0-0"],
  "libgio-2.0.so.0": ["libglib2.0-0", "glib2", "glib2", "libgio-2_0-0"],
  "libdbus-1.so.3": ["libdbus-1-3", "dbus-libs", "dbus", "libdbus-1-3"],
  "libudev.so.1": ["libudev1", "systemd-libs", "systemd-libs", "libudev1"],
};
const column: Record<LinuxFamily, 0 | 1 | 2 | 3> = { debian: 0, fedora: 1, arch: 2, suse: 3 };
const installer: Record<LinuxFamily, string> = {
  debian: "sudo apt-get install -y",
  fedora: "sudo dnf install -y",
  arch: "sudo pacman -S --needed",
  suse: "sudo zypper install -y",
};

/** The distribution family from `/etc/os-release` (`ID`, then `ID_LIKE`); undefined if unknown. */
export function linuxFamily(osRelease: string): LinuxFamily | undefined {
  const field = (name: string) =>
    new RegExp(`^${name}=("?)([^"\\n]*)\\1\\s*$`, "m").exec(osRelease)?.[2]?.toLowerCase() ?? "";
  for (const id of [field("ID"), ...field("ID_LIKE").split(/\s+/)]) {
    if (["debian", "ubuntu"].includes(id)) return "debian";
    if (["fedora", "rhel", "centos"].includes(id)) return "fedora";
    if (["arch", "archlinux"].includes(id)) return "arch";
    if (id === "suse" || id.startsWith("opensuse") || id === "sles") return "suse";
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
    if (name) names.add(name);
  }
  return names.size ? `${installer[family]} ${[...names].join(" ")}` : undefined;
}
