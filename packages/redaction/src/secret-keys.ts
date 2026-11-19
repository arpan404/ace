const SECRET_KEY =
  /token|secret|password|api[_-]?key|authorization|cookie|credential|ticket|pairing[_-]?code|encryptedContent|grant$|^standing$|proof$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}
