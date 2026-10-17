import { createHash } from "node:crypto";

/**
 * The public half of ace for Chrome's signing key (SubjectPublicKeyInfo, base64 DER). As the
 * manifest `key` it fixes the extension id for unpacked installs, so native host manifests can
 * name the one extension allowed to start the host. The private half was never kept.
 */
export const extensionPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5N4sL4V9PmOeOQm3PwQZPWTNoDm4Vq4AXtmhtBNnXh2ZK+qyWzfaz+UUf9L68QM7Oel+bPIxr2eikqWCrBOkQVKl39WPpTwn0TXrxY1MtLYFzPfE7nh00Kk/Qk/hYwwBcwYU5PZcYs5ZhngjqOqGIRqtSbM3TOHIVbY1YY6mrF1b2jcYSmb5Glv4gXmtoNiaDV13OjO5QzhiEPYIhIbAI/O/6X0XJP2skH57Xqc/6z4m2TLt5wRTcB2/bMR02A7ZRAHPCnUsPtTF7NqqVYOjgxQwvsadj+5vWrrb3NJ+yFr4UqJII8l0YJctd0ziyO69KkXAdWvrDfW9giCf6tx9FwIDAQAB";

/** Chrome's extension id for a public key: the first 128 bits of its SHA-256, as letters a–p. */
export function extensionIdFor(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  return Array.from(digest.slice(0, 32), (digit) =>
    String.fromCharCode(97 + Number.parseInt(digit, 16)),
  ).join("");
}

export const extensionId = extensionIdFor(extensionPublicKey);
export const extensionOrigin = `chrome-extension://${extensionId}/`;
