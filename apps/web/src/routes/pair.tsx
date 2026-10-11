import { createFileRoute } from "@tanstack/react-router";
import { PairDeviceScreen } from "@/features/settings/index.ts";

// Before connection, the gate redeems incoming links. Once connected, create a pairing here.
export const Route = createFileRoute("/pair")({ component: PairDeviceScreen });
