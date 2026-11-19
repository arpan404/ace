import { expect, it } from "vitest";
import { computerName, type NameHost } from "./computer-name.ts";

const linux = (machineInfo: string | undefined, name = "ubuntu-desktop"): NameHost => ({
  platform: "linux",
  macName: async () => "",
  machineInfo: async () => machineInfo,
  hostname: () => name,
});

it("a Linux computer is called by the name the person gave it in Settings", async () => {
  expect(
    await computerName(linux('PRETTY_HOSTNAME="Arpan\'s \\"Work\\" Laptop"\nCHASSIS=laptop\n')),
  ).toBe('Arpan\'s "Work" Laptop');
  expect(await computerName(linux("CHASSIS=vm\nPRETTY_HOSTNAME='Studio PC'\n"))).toBe("Studio PC");
});

it("without a given name, a Linux computer is called by its hostname", async () => {
  expect(await computerName(linux(undefined))).toBe("ubuntu desktop");
  expect(await computerName(linux('PRETTY_HOSTNAME=""\n'))).toBe("ubuntu desktop");
  expect(await computerName(linux(undefined, ""))).toBe("This machine");
});

it("a Mac is called by its Computer Name", async () => {
  const mac: NameHost = {
    ...linux(undefined),
    platform: "darwin",
    macName: async () => "Arpan’s MacBook Pro",
  };
  expect(await computerName(mac)).toBe("Arpan’s MacBook Pro");
});
