import { expect, it } from "vitest";
import { allowedReturnTo, returnAddress } from "./return-to.ts";

const origins = ["https://app.example", "http://localhost:5173", "app://ace"];

it("a sign-in returns only to the apps' link or an allowed web origin's landing page", () => {
  for (const accepted of [
    "ace://account/signed-in",
    "https://app.example/account/signed-in",
    "http://localhost:5173/account/signed-in",
  ])
    expect(allowedReturnTo(accepted, origins)).toBe(accepted);
  for (const refused of [
    "https://attacker.example/account/signed-in",
    "https://app.example/settings/general",
    "https://app.example/account/signed-in?next=https://attacker.example",
    "https://app.example/account/signed-in#x",
    "https://app.example.attacker.example/account/signed-in",
    "https://app.example@attacker.example/account/signed-in",
    "app://ace/account/signed-in",
    "ace://account/signed-in?status=signed-in",
    "ace://thread/1",
    "ACE://account/signed-in",
    "",
  ])
    expect(allowedReturnTo(refused, origins)).toBeUndefined();
});

it("the return address carries only how the sign-in ended", () => {
  expect(returnAddress("ace://account/signed-in", "cancelled")).toBe(
    "ace://account/signed-in?status=cancelled",
  );
});
