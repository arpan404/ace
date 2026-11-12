import { spadeUnconfirmedNote } from "@ace/ui-core/spade-chat";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * A new Spade conversation in the real app over the fake daemon's Spade, when the start's answer
 * is lost and so is the start sent again by its key: the words stay for the person to decide.
 */

test("a start Spade may have made keeps its words in the composer, under the note", async () => {
  const app = harness();
  app.daemon.spade.status = { state: "ready", version: "0.4.0" };
  app.daemon.services.settings.seed({ "spade.enabled": true });
  // An earlier conversation, so the list shows Spade keeps start keys.
  app.daemon.spade.seed("earlier", "Earlier", [{ type: "user_message", text: "Hello" }]);
  await app.open("/spade");
  const editor = await screen.findByRole("combobox", { name: "Message Spade" });
  await userEvent.type(editor, "Plan my week");
  app.daemon.spade.holding = (request) => request.method === "POST";
  await userEvent.keyboard("{Enter}");
  // The start never gets through: the socket drops with it out, and again with the start sent
  // again by its key, so whether Spade has it can't be told.
  await waitFor(() => expect(app.daemon.spade.waiting).toBe(1));
  app.daemon.disconnectAll();
  await waitFor(() => expect(app.daemon.spade.waiting).toBe(2), { timeout: 8_000 });
  app.daemon.disconnectAll();

  expect(await screen.findByText(spadeUnconfirmedNote, {}, { timeout: 8_000 })).toBeTruthy();
  expect((await screen.findByRole("combobox", { name: "Message Spade" })).textContent).toBe(
    "Plan my week",
  );
}, 20_000);
