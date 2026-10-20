import { expect, test } from "vitest";
import { sanitize } from "./redaction.ts";

test("opaque provider state is redacted under both its 2.0 and 2.1 names, text is kept", () => {
  const event = {
    type: "session.text.ended",
    data: {
      text: "Pushed.",
      providerState: { reasoningEncryptedContent: "secret-20" },
      native: { itemId: "rs_1", reasoningEncryptedContent: "secret-21" },
    },
  };
  const clean = sanitize(event);
  expect(clean).toEqual({
    type: "session.text.ended",
    data: { text: "Pushed.", providerState: "[redacted]", native: "[redacted]" },
  });
});

test("fields that only contain the word native are not redacted", () => {
  expect(sanitize({ nativeSessionId: "ses_1", native_name: "shell" })).toEqual({
    nativeSessionId: "ses_1",
    native_name: "shell",
  });
});
