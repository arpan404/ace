import { expect, it } from "vitest";
import { CertificateExceptions } from "./certificates.ts";

it("a certificate the person trusted passes only for its own origin and fingerprint", () => {
  const exceptions = new CertificateExceptions();
  exceptions.allow("https://localhost:5173/app", "sha256/dev");
  expect(exceptions.allows("https://localhost:5173/other", "sha256/dev")).toBe(true);
  expect(exceptions.allows("https://localhost:5173/app", "sha256/swapped")).toBe(false);
  expect(exceptions.allows("https://localhost:8443/app", "sha256/dev")).toBe(false);
  expect(exceptions.allows("http://localhost:5173/app", "sha256/dev")).toBe(false);
});
