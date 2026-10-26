import { installWebPlatform } from "@ace/native-host";
import { host } from "./host.ts";

// The portable SDK's required Web APIs, backed by the native host where the engine lacks them.
installWebPlatform(host);

export { host };
