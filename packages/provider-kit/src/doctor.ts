import { discoverProviders } from "./discovery/index.ts";
import { installShutdownHandlers } from "./process.ts";
const disposeShutdown = installShutdownHandlers({ graceMs: 1000 });
try {
  const results = await discoverProviders();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.table(
      Object.entries(results).map(([provider, result]) => ({
        provider,
        installed: result.installed,
        version: result.version ?? "",
        auth: result.auth,
        detail: result.authDetail ?? "",
        evidence: result.authEvidence ?? "",
        login: result.loginHint,
        error: result.error ?? "",
      })),
    );
  }
} finally {
  disposeShutdown();
}
