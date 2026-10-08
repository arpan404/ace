import { createFileRoute } from "@tanstack/react-router";

/** Any old `/more/…` address; its parent sends it where that page lives now. */
export const Route = createFileRoute("/more/$")({});
