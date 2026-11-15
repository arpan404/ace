import { keepAliveCases } from "./keep-alive-test-support.ts";

// The same cases on Node, the runtime release builds use: its HTTP server arms its own socket
// timeout when a response finishes.
keepAliveCases();
