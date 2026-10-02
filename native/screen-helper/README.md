# macOS screen helper

Build with `./build.sh` on macOS 13+. Other hosts skip successfully. The output is `build/ace-screen-helper`, ad-hoc signed under `dev.ace.screen-helper`. `build-test-window.sh` builds the isolated integration-test application.

The daemon owns the helper through `@ace/provider-kit/process`. Launch with `--socket PATH` pointing at the private Unix socket created by `@ace/screen`. Stdin and stdout carry bounded newline JSON version-1 commands and replies. The socket carries independently decodable JPEG packets. The helper has no network listener and never requests macOS permission automatically.

Read [the package documentation](../../packages/screen/README.md) for permissions, framing, approval and focus checks, client indicators, recordings, simulator control and integration tests. Design decisions are in [ADR 0011](../../docs/adr/0011-screen-and-computer-use.md).
