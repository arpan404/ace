import { PublicToolError } from "@ace/mcp-server/errors";
import { describe, expect, it } from "vitest";
import { agentBrowserError } from "./agent-errors.ts";
import { linuxLaunchDiagnosis, smallSharedMemory, type LinuxMachine } from "./launch-diagnosis.ts";

const ubuntu = 'PRETTY_NAME="Ubuntu 26.04 LTS"\nID=ubuntu\nID_LIKE=debian\n';
const fedora = 'NAME="Fedora Linux"\nID=fedora\n';
const arch = 'NAME="Arch Linux"\nID=arch\n';
const tumbleweed =
  'NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n';
const loaderError =
  "/home/a/.ace/chromium/x/chrome-linux64/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory\n";
const ldd = [
  "\tlinux-vdso.so.1 (0x0000ffff)",
  "\tlibnss3.so => not found",
  "\tlibasound.so.2 => not found",
  "\tlibc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x0000ffff)",
].join("\n");
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

describe("Chrome start failures on Linux", () => {
  it("names every missing library and the apt command on Ubuntu", async () => {
    const seen = await agentSees(loaderError, machine({ "/etc/os-release": ubuntu }));
    expect(seen.code).toBe("browser_missing_libraries");
    expect(seen.detail).toBe(
      "Missing libnss3.so, libasound.so.2. Run: sudo apt-get install -y libnss3 libasound2",
    );
  });

  it("uses each distribution's own installer and package names", async () => {
    expect(await detail(fedora)).toMatch(/sudo dnf install -y nss alsa-lib$/);
    expect(await detail(arch)).toMatch(/sudo pacman -S --needed nss alsa-lib$/);
    expect(await detail(tumbleweed)).toMatch(/sudo zypper install -y mozilla-nss libasound2$/);
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
