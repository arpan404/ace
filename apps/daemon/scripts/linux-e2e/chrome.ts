/*
 * ace's pinned Chrome for the Linux end-to-end run, and the AppArmor profile that lets its
 * sandbox start on Ubuntu 23.10+, from the same source `ace doctor` prints it from.
 *   node apps/daemon/scripts/linux-e2e/chrome.ts install <data-dir>       prints the executable
 *   node apps/daemon/scripts/linux-e2e/chrome.ts apparmor <executable> <profile-name>
 */
import { installChromium } from "@ace/browser";
import {
  chromiumAppArmorProfile,
  chromiumAppArmorProfileName,
  chromiumAttachmentForExecutable,
} from "@ace/browser/linux-sandbox";

const [command, target, name] = process.argv.slice(2);
if (command === "install" && target) {
  console.log(await installChromium(target));
} else if (command === "apparmor" && target && name) {
  // A profile name of its own, so the run never replaces a profile the machine already has.
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Profile names are lowercase words and dashes");
  const profile = chromiumAppArmorProfile(chromiumAttachmentForExecutable(target))
    .replace(`profile ${chromiumAppArmorProfileName} `, `profile ${name} `)
    .replace(`<local/${chromiumAppArmorProfileName}>`, `<local/${name}>`);
  process.stdout.write(profile);
} else {
  console.error("Usage: chrome.ts install <data-dir> | apparmor <executable> <profile-name>");
  process.exit(2);
}
