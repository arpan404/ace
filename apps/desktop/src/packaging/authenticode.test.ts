import { expect, test } from "vitest";
import {
  windowsSigning,
  windowsSigningConfig,
  windowsSigningConfigured,
} from "./release-signing.ts";

const certificate = {
  WIN_CSC_LINK: "C:\\keys\\ace.pfx",
  WIN_CSC_KEY_PASSWORD: "secret",
  ACE_WINDOWS_PUBLISHER: "ace",
};

test("a signed Windows build signs executables including ace-media, native addons and DLLs", () => {
  const config = windowsSigningConfig(windowsSigning(certificate));
  expect(config.signExts).toEqual([".exe", ".node", ".dll"]);
  expect(config).toMatchObject({ signtoolOptions: { publisherName: ["ace"] } });
});

test("Azure Trusted Signing signs the same files under the configured publisher", () => {
  const config = windowsSigningConfig(
    windowsSigning({
      ACE_AZURE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
      ACE_AZURE_SIGNING_ACCOUNT: "ace",
      ACE_AZURE_CERTIFICATE_PROFILE: "release",
      AZURE_TENANT_ID: "t",
      AZURE_CLIENT_ID: "c",
      ACE_WINDOWS_PUBLISHER: "ace",
    }),
  );
  expect(config.signExts).toEqual([".exe", ".node", ".dll"]);
  expect(config).toMatchObject({ azureSignOptions: { publisherName: "ace" } });
});

test("a half-configured certificate names what is missing, and none builds unsigned", () => {
  expect(windowsSigning({ WIN_CSC_LINK: "C:\\keys\\ace.pfx" })).toEqual({
    kind: "incomplete",
    missing: ["WIN_CSC_KEY_PASSWORD", "ACE_WINDOWS_PUBLISHER"],
  });
  expect(windowsSigningConfig(windowsSigning({}))).toEqual({});
});

test("unsigned Windows packages skip signature verification while configured signers require it", () => {
  expect(windowsSigningConfigured(windowsSigning({}))).toBe(false);
  expect(windowsSigningConfigured(undefined)).toBe(false);
  expect(windowsSigningConfigured(windowsSigning(certificate))).toBe(true);
  expect(
    windowsSigningConfigured({
      kind: "azure",
      publisherName: "ace",
      endpoint: "endpoint",
      codeSigningAccountName: "account",
      certificateProfileName: "release",
    }),
  ).toBe(true);
});
