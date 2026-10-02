/** Linear validation with constant auxiliary memory, including canonical padding bits. */
export function canonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding;
  let last = 0;
  for (let i = 0; i < end; i++) {
    const code = value.charCodeAt(i);
    if (code >= 65 && code <= 90) last = code - 65;
    else if (code >= 97 && code <= 122) last = code - 71;
    else if (code >= 48 && code <= 57) last = code + 4;
    else if (code === 43) last = 62;
    else if (code === 47) last = 63;
    else return false;
  }
  return padding === 0 || (end > 0 && (last & (padding === 2 ? 15 : 3)) === 0);
}
