import { expect, it } from "vitest";
import { NoiseXX, keyPair } from "@ace/secure-channel";
import { CONTROL_PROLOGUE, ControlMessage, RelayRoutes } from "@ace/relay/wire";
import { hostId } from "@ace/secure-channel";
import { openControl, sealControl } from "./control.ts";
import { Attachment, hostAccount, routeFacts } from "./attachment.ts";

function registration() {
  const daemonKeys = keyPair();
  const daemon = new NoiseXX({
    initiator: true,
    staticKey: daemonKeys,
    ephemeralKey: keyPair(),
    prologue: CONTROL_PROLOGUE,
  });
  const relay = new NoiseXX({
    initiator: false,
    staticKey: keyPair(),
    ephemeralKey: keyPair(),
    prologue: CONTROL_PROLOGUE,
  });
  relay.readMessage(daemon.writeMessage());
  daemon.readMessage(relay.writeMessage());
  relay.readMessage(daemon.writeMessage());
  return { daemon: daemon.transport, relay: relay.transport, id: hostId(daemonKeys.publicKey) };
}

it("a registration session saved between messages stays in step with the daemon's live session", () => {
  const { daemon, relay, id } = registration();
  // Each message goes through a structured-clone round trip, as attachments do in hibernation.
  let saved = structuredClone({ send: relay.send.snapshot(), receive: relay.receive.snapshot() });
  relay.destroy();
  for (const message of [
    { type: "registered", hostId: id },
    { type: "client", ticket: "a".repeat(64) },
  ] as const) {
    const sealed = sealControl(saved.send, message);
    saved = structuredClone({ ...saved, send: sealed.next });
    expect(
      ControlMessage.parse(
        JSON.parse(new TextDecoder().decode(daemon.receive.decrypt(sealed.frame))),
      ),
    ).toEqual(message);
  }
  const reject = daemon.send.encrypt(
    new TextEncoder().encode(JSON.stringify({ type: "reject", ticket: "a".repeat(64) })),
  );
  const opened = openControl(saved.receive, reject);
  expect(opened.message).toEqual({ type: "reject", ticket: "a".repeat(64) });
  expect(() => openControl(opened.next, reject)).toThrow();
});

it("attachments read after hibernation restore the host's account and routes that pair the waiting client", () => {
  const { id } = registration();
  const ticket = "b".repeat(64);
  const attachments = [
    {
      kind: "host",
      id: "h",
      hostId: id,
      account: "user_a",
      send: { key: new Uint8Array(32), nonce: 3n },
      receive: { key: new Uint8Array(32), nonce: 0n },
    },
    { kind: "waiting", id: "c", ticket, owner: "h", expires: 500 },
    { kind: "stream", id: "s1", peer: "s2" },
  ].map((value) => Attachment.parse(structuredClone(value)));
  expect(hostAccount(attachments, id)).toBe("user_a");
  const routes = new RelayRoutes({ ticketTimeoutMs: 100 });
  const { hosts, pending } = routeFacts(attachments);
  expect(routes.restore(hosts, pending)).toEqual([]);
  expect(routes.join("j", ticket, 100)).toEqual([{ type: "pair", client: "c", host: "j" }]);
  expect(routes.request("c2", id, "c".repeat(64), 100)).toEqual([
    { type: "offer", socket: "h", ticket: "c".repeat(64) },
  ]);
});
