# Secure channel

`@ace/secure-channel` implements `Noise_XX_25519_ChaChaPoly_SHA256` from [Noise revision 34](https://noiseprotocol.org/noise.html). It supports the three XX handshake messages and ordered bidirectional transport.

```ts
import { NoiseXX, keyPair, fingerprint } from "@ace/secure-channel";

const hostKeys = keyPair();
const client = new NoiseXX({
  initiator: true,
  ephemeralKey: keyPair(),
  staticKey: keyPair(),
  pinnedFingerprint: fingerprint(hostKeys.publicKey),
});
const host = new NoiseXX({ initiator: false, staticKey: hostKeys, ephemeralKey: keyPair() });
host.readMessage(client.writeMessage());
client.readMessage(host.writeMessage());
host.readMessage(client.writeMessage());
const plaintext = host.transport.receive.decrypt(
  client.transport.send.encrypt(new TextEncoder().encode("message")),
);
client.transport.destroy();
host.transport.destroy();
```

Use `loadOrCreateHostKeys(dataDir)` from `@ace/secure-channel/node` in the daemon. It publishes `noise-static.key` atomically, syncs the file and directory, rejects symlinks and corrupt keys, and requires mode 0600. Concurrent starts use the same key. `fingerprint(publicKey)` and `hostId(publicKey)` are the same uppercase, unpadded RFC 4648 base32 encoding of SHA-256 of the 32-byte static public key. Pairing must pin this value over its trusted pairing path.

An existing identity is loaded before attempting any writes. The descriptor must be a regular mode-0600 file of exactly 32 bytes. Reads use a fixed 33-byte buffer and recheck the descriptor size after EOF to reject observed growth or shrinkage. The loader's optional second argument is a trusted `OpenHostIdentity` descriptor opener for injecting read I/O. The loader supplies the no-follow and nonblocking flags and owns descriptor closure; atomic publication still uses the native filesystem. Tests wrap real descriptors to schedule competing writes at stat/read boundaries.

The main entry point uses only typed arrays and the pinned noble 2.0.1 libraries. Noble's [curves](https://github.com/paulmillr/noble-curves), [ciphers](https://github.com/paulmillr/noble-ciphers) and [hashes](https://github.com/paulmillr/noble-hashes) projects publish independent audit reports and test their implementations against other implementations. Pure JavaScript keeps one cryptographic implementation across Node, browsers and React Native. Node's native ChaCha20-Poly1305 is not a shared browser or React Native API. The filesystem helper has a separate Node entry point so portable imports do not pull in filesystem code. React Native must install a cryptographically secure `crypto.getRandomValues` polyfill before importing or generating keys. Browser and React Native runtime tests remain for the client workers; Node vector tests pass.

Nonce counters start at zero, use four zero bytes followed by a little-endian uint64, and never serialize a nonce into the transport frame. The reserved `2^64 - 1` nonce is used only for rekeying. Exhaustion destroys the cipher. AEAD rejection leaves the receive nonce unchanged as the spec requires. The relay helpers terminate their channel on any authentication failure, including replay or reordering.

`CipherState.rekey()` implements the spec's default rekey operation without resetting the nonce. Both peers must rekey the same direction at the same message boundary. The relay helpers do this every `2^20` encrypted stream fragments. Direct users own that coordination. All Noise messages are at most 65,535 bytes; transport plaintext is at most 65,519 bytes. A handshake error permanently aborts the state, and completion erases its copied private keys and chaining key. JavaScript erasure is best effort; the runtime can retain temporary copies.

Noise XX's first handshake payload is plaintext by specification. The integration helpers always use empty handshake payloads and send daemon messages only after the handshake completes. Direct callers must apply the same rule for secrets. The client's pin is checked immediately after decrypting the responder static key, before it sends its final handshake message. XX proves the client's fresh static key as well, but device authorization still belongs to the daemon's existing wire `hello` message and device-token validation.

The implementation is written from the specification. The [vendored fixture notes](fixtures/README.md) record test-data sources and licenses. This Noise state machine has not had an independent cryptographic audit.

Generate fresh ephemerals with `keyPair()` at the I/O boundary and pass `ephemeralKey` to each `NoiseXX` instance. The state machine performs no random generation. `CipherState(key, initialNonce = 0n)` permits restoring an explicitly managed counter and testing exhaustion; ordinary sessions always start at zero. Never restore a key with a counter that could reuse a nonce.
