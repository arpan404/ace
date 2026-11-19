# Test TLS fixtures (D2)

For `relay-media.process.test.ts` only. Nothing here is trusted anywhere else: the test hands
`ca.pem` to its own ace-media child as `SSL_CERT_FILE`, which replaces the OS trust store for
that process alone. The keychain and system trust settings are never touched.

- `ca.pem`, `other-ca.pem`: test CAs. Their private keys were discarded after signing, so no
  further certificate can be made from them.
- `localhost`: valid until 2126, for `localhost` and `127.0.0.1`, from `ca`.
- `wrong-host`: valid, from `ca`, but for `wrong.test` only.
- `expired`: for `localhost`, from `ca`, valid 2020 to 2021.
- `untrusted`: valid, for `localhost`, from `other-ca`, which the test never trusts.

Each `*.key.pem` is the leaf key the test relay serves with.
