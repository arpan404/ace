import { expect, it } from "vitest";
import { appIdentities, systemApplication, systemApplicationIcon } from "./app-identity.ts";

it.skipIf(process.platform !== "darwin")(
  "installed system apps have their own distinct OS icons",
  async () => {
    const read = appIdentities({
      application: (bundleId) => systemApplication(bundleId, process.platform),
      icon: (path) => systemApplicationIcon(path, process.platform),
    });
    const calculator = await read("com.apple.calculator");
    const textEdit = await read("com.apple.TextEdit");
    expect(calculator?.displayName).toBeTruthy();
    expect(textEdit?.displayName).toBeTruthy();
    expect(calculator?.icon).toMatch(/^data:image\/png;base64,/);
    expect(textEdit?.icon).toMatch(/^data:image\/png;base64,/);
    expect(calculator?.icon).not.toEqual(textEdit?.icon);
  },
);
