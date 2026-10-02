import { discoverProviders } from "./discovery/index.ts";
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
      login: result.loginHint,
      error: result.error ?? "",
    })),
  );
}
