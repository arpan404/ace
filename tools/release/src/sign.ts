import { readFile, writeFile, realpath } from "node:fs/promises";
import { createPrivateKey, sign } from "node:crypto";
import { resolve, sep } from "node:path";
import { ReleaseManifest } from "@ace/protocol";
import { installableVersion } from "@ace/service";
const [manifestPath, keyPath, signaturePath] = process.argv.slice(2);
if (!manifestPath || !keyPath || !signaturePath)
  throw new Error("Usage: sign MANIFEST PRIVATE_KEY_OUTSIDE_REPO SIGNATURE_PATH");
const actualKeyPath = await realpath(keyPath);
const repository = resolve(import.meta.dirname, "../../..");
if (actualKeyPath === repository || actualKeyPath.startsWith(repository + sep))
  throw new Error("Signing key must be outside the repository");
const bytes = await readFile(manifestPath);
installableVersion(ReleaseManifest.parse(JSON.parse(bytes.toString())).version);
const key = createPrivateKey(await readFile(actualKeyPath));
if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 signing key required");
await writeFile(signaturePath, sign(null, bytes, key).toString("base64") + "\n");
