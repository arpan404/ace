import { PublicToolError } from "@ace/mcp-server/errors";
import { createRedactor } from "@ace/redaction";
import { chromeLogText } from "./launch-failure.ts";
import { describe, expect, it } from "vitest";
import { agentBrowserError } from "./agent-errors.ts";
import { linuxLaunchDiagnosis, smallSharedMemory, type LinuxMachine } from "./launch-diagnosis.ts";

const ubuntu = 'PRETTY_NAME="Ubuntu 26.04 LTS"\nID=ubuntu\nID_LIKE=debian\n';
const fedora = 'NAME="Fedora Linux"\nID=fedora\n';
const arch = 'NAME="Arch Linux"\nID=arch\n';
const loaderError =
  "/home/a/.ace/chromium/x/chrome-linux64/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory\n";
const ldd = [
  "\tlinux-vdso.so.1 (0x0000ffff)",
  "\tlibnss3.so => not found",
  "\tlibasound.so.2 => not found",
  "\tlibc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x0000ffff)",
].join("\n");
/** `/etc/os-release` and `ldd chrome` (153.0.8010.12 linux-arm64) on a base Arch Linux ARM system. */
const archLinuxArm =
  'NAME="Arch Linux ARM"\nPRETTY_NAME="Arch Linux ARM"\nID=archarm\nID_LIKE=arch\nBUILD_ID=rolling\n';
const archBaseLdd = `	linux-vdso.so.1 (0x0000f25a199cc000)
	libdl.so.2 => /usr/lib/libdl.so.2 (0x0000f25a085a0000)
	libglib-2.0.so.0 => /usr/lib/libglib-2.0.so.0 (0x0000f25a083d0000)
	libnspr4.so => not found
	libnss3.so => not found
	libnssutil3.so => not found
	libsmime3.so => not found
	libgio-2.0.so.0 => /usr/lib/libgio-2.0.so.0 (0x0000f25a080e0000)
	libatk-1.0.so.0 => not found
	libatk-bridge-2.0.so.0 => not found
	libdbus-1.so.3 => /usr/lib/libdbus-1.so.3 (0x0000f25a08060000)
	libcups.so.2 => not found
	libexpat.so.1 => /usr/lib/libexpat.so.1 (0x0000f25a08010000)
	libxcb.so.1 => not found
	libxkbcommon.so.0 => not found
	libasound.so.2 => not found
	libgbm.so.1 => not found
	libX11.so.6 => not found
	libXext.so.6 => not found
	libcairo.so.2 => not found
	libpango-1.0.so.0 => not found
	libudev.so.1 => /usr/lib/libudev.so.1 (0x0000f25a07f80000)
	libXcomposite.so.1 => not found
	libXdamage.so.1 => not found
	libXfixes.so.3 => not found
	libXrandr.so.2 => not found
	libatspi.so.0 => not found
	libc.so.6 => /usr/lib/libc.so.6 (0x0000f25a07c90000)
	/lib/ld-linux-aarch64.so.1 => /usr/lib/ld-linux-aarch64.so.1 (0x0000f25a19990000)
`;
const noSandbox =
  "[43829:43829:1020/191750.273993:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.\n#0 0xbf1ff402abcc\n[end of stack trace]\n";
const asRoot =
  "[43862:43862:1020/191752.834117:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:102] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.\n";

function machine(files: Record<string, string>, root = false): LinuxMachine {
  return {
    readText: async (path) => files[path],
    ldd: async () => ldd,
    root,
  };
}
/** What an agent sees after Chrome failed to start with `stderr` on `host`. */
async function agentSees(stderr: string, host: LinuxMachine) {
  const failure = {
    executable: "/home/a/.ace/chromium/x/chrome-linux64/chrome",
    stderr,
    error: new Error("Chrome failed to start: Browser pipe closed"),
  };
  const error = agentBrowserError(await linuxLaunchDiagnosis(host)(failure));
  if (!(error instanceof PublicToolError)) throw new Error("Expected a public failure");
  return error;
}

const detail = async (osRelease: string) =>
  (await agentSees(loaderError, machine({ "/etc/os-release": osRelease }))).detail;

const release = (fields: string) => detail(`ID_LIKE=debian\n${fields}`);

describe("Chrome start failures on Linux", () => {
  it("names every missing library and the apt command on Ubuntu", async () => {
    const seen = await agentSees(loaderError, machine({ "/etc/os-release": ubuntu }));
    expect(seen.code).toBe("browser_missing_libraries");
    expect(seen.detail).toBe(
      "Missing libnss3.so, libasound.so.2. Run: sudo apt-get install -y libnss3 libasound2t64",
    );
  });

  it("uses the 64-bit time package names only on the releases that renamed them", async () => {
    expect(await release('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble')).toMatch(
      / libasound2t64$/,
    );
    expect(await release('ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm')).toMatch(
      / libasound2$/,
    );
    expect(await release('ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie')).toMatch(
      / libasound2t64$/,
    );
    // LMDE 6 builds on Debian 12 and says so.
    expect(await release("ID=linuxmint\nVERSION_CODENAME=faye\nDEBIAN_CODENAME=bookworm")).toMatch(
      / libasound2$/,
    );
  });

  it("uses each distribution's own installer and package names", async () => {
    expect(await detail(fedora)).toMatch(/sudo dnf install -y nss alsa-lib$/);
    expect(await detail(arch)).toMatch(/sudo pacman -S --needed nss alsa-lib$/);
  });

  it("installs what a base Arch Linux ARM system lacks, by Arch's own package names", async () => {
    const host: LinuxMachine = {
      ...machine({ "/etc/os-release": archLinuxArm }),
      ldd: async () => archBaseLdd,
    };
    const seen = await agentSees(loaderError, host);
    expect(seen.code).toBe("browser_missing_libraries");
    // Checked against `pacman -F` on Arch Linux ARM and x86_64 Arch: with these installed,
    // `ldd` finds every library and Chrome starts.
    const command = "Run: sudo pacman -S --needed ";
    expect(seen.detail?.startsWith(command)).toBe(true);
    expect(seen.detail?.slice(command.length).split(" ").toSorted()).toEqual([
      "alsa-lib",
      "at-spi2-core",
      "cairo",
      "libcups",
      "libx11",
      "libxcb",
      "libxcomposite",
      "libxdamage",
      "libxext",
      "libxfixes",
      "libxkbcommon",
      "libxrandr",
      "mesa",
      "nspr",
      "nss",
      "pango",
    ]);
  });

  it("never hands the agent a cut-off install command for a bare machine", async () => {
    const bare = [
      "libglib-2.0.so.0",
      "libnss3.so",
      "libatk-1.0.so.0",
      "libatk-bridge-2.0.so.0",
      "libdbus-1.so.3",
      "libcups.so.2",
      "libexpat.so.1",
      "libxcb.so.1",
      "libxkbcommon.so.0",
      "libasound.so.2",
      "libgbm.so.1",
      "libX11.so.6",
      "libXext.so.6",
      "libcairo.so.2",
      "libpango-1.0.so.0",
      "libXcomposite.so.1",
      "libXdamage.so.1",
      "libXfixes.so.3",
      "libXrandr.so.2",
      "libatspi.so.0",
      "libnspr4.so",
    ];
    const host: LinuxMachine = {
      ...machine({ "/etc/os-release": ubuntu }),
      ldd: async () => bare.map((name) => `\t${name} => not found`).join("\n"),
    };
    const seen = await agentSees(loaderError, host);
    expect(seen.code).toBe("browser_missing_libraries");
    expect(seen.detail).toMatch(/^Missing 21 system libraries Chrome needs \(libnss3\.so, /);
    expect(seen.detail).toMatch(/Run ace doctor on this machine for the install command\.$/);
  });

  it("still names the libraries on a distribution it has no command for", async () => {
    const seen = await agentSees(loaderError, machine({ "/etc/os-release": "ID=gentoo\n" }));
    expect(seen.code).toBe("browser_missing_libraries");
    expect(seen.detail).toBe("Missing libnss3.so, libasound.so.2. Install them");
  });

  it("blames AppArmor and offers the profile or the opt-out when Ubuntu restricts user namespaces", async () => {
    const seen = await agentSees(
      noSandbox,
      machine({
        "/etc/os-release": ubuntu,
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
      }),
    );
    expect(seen.code).toBe("browser_sandbox_blocked");
    expect(seen.detail).toMatch(/AppArmor/);
    expect(seen.detail).toMatch(/ace doctor/);
    expect(seen.detail).toMatch(/ACE_CHROMIUM_NO_SANDBOX=1/);
  });

  it("points at the kernel switch where user namespaces are off without AppArmor", async () => {
    const seen = await agentSees(
      noSandbox,
      machine({ "/proc/sys/kernel/unprivileged_userns_clone": "0\n" }),
    );
    expect(seen.code).toBe("browser_sandbox_blocked");
    expect(seen.detail).toMatch(/kernel\.unprivileged_userns_clone=1/);
  });

  it("never points at AppArmor on a kernel without its user-namespace restriction", async () => {
    // Arch's kernel: the clone switch exists and allows user namespaces; no AppArmor sysctl.
    const seen = await agentSees(
      noSandbox,
      machine({ "/etc/os-release": arch, "/proc/sys/kernel/unprivileged_userns_clone": "1\n" }),
    );
    expect(seen.code).toBe("browser_sandbox_blocked");
    expect(seen.detail).not.toMatch(/AppArmor|apparmor/);
    expect(seen.detail).toMatch(/ace doctor/);
  });

  it("tells the person ace runs as root rather than blaming the sandbox setup", async () => {
    const seen = await agentSees(asRoot, machine({}, true));
    expect(seen.code).toBe("browser_sandbox_blocked");
    expect(seen.detail).toMatch(/runs as root/);
  });

  it("keeps an unrecognised failure as browser_unavailable", async () => {
    const seen = await agentSees("[1:1:ERROR:gpu] something else\n", machine({}));
    expect(seen.code).toBe("browser_unavailable");
  });
});

describe("the daemon log", () => {
  it("keeps Chrome's fatal line readable after redaction", () => {
    const redact = createRedactor({ home: "/home/a", env: {} });
    expect(redact(chromeLogText(noSandbox.split("\n")[0] ?? ""))).toMatch(
      /^FATAL zygote_host_impl_linux\.cc:129: No usable sandbox! If you are running on Ubuntu 23\.10\+/,
    );
  });
});

describe("shared memory", () => {
  it("moves Chrome's shared memory out of a container-sized /dev/shm only", () => {
    expect(smallSharedMemory(() => ({ blocks: 16_384, bsize: 4096 }))).toBe(true);
    expect(smallSharedMemory(() => ({ blocks: 2_000_000, bsize: 4096 }))).toBe(false);
    expect(
      smallSharedMemory(() => {
        throw new Error("ENOENT");
      }),
    ).toBe(true);
  });
});
