# Autobahn fuzzingclient for the native transport (T1b.5)

`fuzzingclient.json` runs every case (`"cases": ["*"]`) against `ace-transport`'s own HTTP/1.1
head parse, WebSocket handshake, framing and `permessage-deflate`, served over plain TCP on
`127.0.0.1:9001` by `examples/autobahn_echo.rs`. TLS is rustls', already fuzzed upstream, so it is
not part of this run.

`scripts/transport-autobahn.ts` builds the example, runs the suite against it, then runs the same
suite against a scratch `ws` 8.22 echo server with `remoteDeflate` on the same port, and compares
the two reports. It never pulls the image and never runs in CI.

The suite runs from the official image, `crossbario/autobahn-testsuite`, which is Apache-2.0
(<https://github.com/crossbario/autobahn-testsuite>). Pull it once, offline, with the owner's
go-ahead:

```sh
docker pull crossbario/autobahn-testsuite
```

The report is written under the run's `--out` directory (the OS temp folder by default), never
into this checkout.
