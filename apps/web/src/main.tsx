import type { Client } from "@ace/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, createQueryClient } from "./app.tsx";
import "./styles/index.css";

async function connect(): Promise<Client> {
  // The fake daemon is only bundled in `vite --mode fake`.
  if (import.meta.env.MODE === "fake") return (await import("./boot/fake.ts")).bootFake().client;
  return (await import("./boot/daemon.ts")).bootDaemon();
}

const client = await connect();
await client.start();
addEventListener("online", () => client.networkOnline(true));
addEventListener("offline", () => client.networkOnline(false));

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <App
      client={client}
      queryClient={createQueryClient()}
      environment={{
        storage: localStorage,
        matchMedia: (query) => matchMedia(query),
        root: document.documentElement,
      }}
    />
  </StrictMode>,
);
