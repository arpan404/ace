import { spadeUnconfirmedNote } from "@ace/ui-core/spade-chat";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * A new Spade conversation in the real app over the fake daemon's Spade, when the start's answer
 * is lost and Spade's copy can't be told apart: the words stay for the person to decide.
 */

test("a start Spade may have made keeps its words in the composer, under the note", async () => {
  const app = harness();
  app.daemon.spade.status = { state: "ready", version: "0.4.0" };
  app.daemon.services.settings.seed({ "spade.enabled": true });
  await app.open("/spade");
  const editor = await screen.findByRole("combobox", { name: "Message Spade" });
  await userEvent.type(editor, "Plan my week");
  app.daemon.spade.holding = (request) => request.method === "POST";
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(app.daemon.spade.waiting).toBe(1));
  // Another conversation opening with the same words appears, so Spade's copy can't be told apart.
  app.daemon.spade.seed("elsewhere", "", [{ type: "user_message", text: "Plan my week" }]);
  // Spade makes it, then the socket drops before its answer arrives.
  app.daemon.spade.letThrough(false);
  app.daemon.disconnectAll();

  expect(await screen.findByText(spadeUnconfirmedNote, {}, { timeout: 8_000 })).toBeTruthy();
  expect((await screen.findByRole("combobox", { name: "Message Spade" })).textContent).toBe(
    "Plan my week",
  );
}, 15_000);
