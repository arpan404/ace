# Noise XX test vector provenance

These files contain only the `Noise_XX_25519_ChaChaPoly_SHA256` entries from the upstream cacophony and snow suites. Every field and message byte is preserved; unrelated patterns were removed. No upstream implementation was consulted or copied.

The [Noise project's test vector index](https://github.com/noiseprotocol/noise_wiki/wiki/Test-vectors) identifies these suites. Both files were retrieved from [snow commit 8ac60f51cfe3e010c84f0a454cc575ad9204fa12](https://github.com/mcginty/snow/tree/8ac60f51cfe3e010c84f0a454cc575ad9204fa12/tests/vectors) on 2026-10-02.

| Fixture | Upstream file | SHA-256 of the complete upstream file |
| --- | --- | --- |
| `cacophony.json` | `tests/vectors/cacophony.txt` | `3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae` |
| `snow.json` | `tests/vectors/snow.txt` | `69da433305fd045f6c9f01b656662a389d022688986fd39fbe7af009cd402fd3` |

The requested fixture vendoring accepts snow's MIT license for this test data, with its notice retained in `LICENSE-snow`. The original [cacophony project](https://github.com/centromere/cacophony) releases its data under the Unlicense, retained in `LICENSE-cacophony`. This acceptance covers these fixtures only.

Tests compare all three handshake ciphertexts, every subsequent transport ciphertext in both directions, decoded payloads, and cacophony's final handshake hash. Deterministic ephemeral keys are injected only for these tests.

## Noise NK vectors

`nk.json` holds `Noise_NK_25519_ChaChaPoly_SHA256` vectors (ADR 0155). Published NK vectors for this suite exist in the same upstream files, but only the XX entries were vendored. These were made by `scripts/nk-vectors.ts` with ace's own NK from the cacophony XX vector's keys and prologue, and `src/noise-nk-vectors.test.ts` checks every byte against an independent derivation written from the Noise specification on `node:crypto` (OpenSSL's X25519, HKDF, SHA-256 and ChaCha20-Poly1305).
