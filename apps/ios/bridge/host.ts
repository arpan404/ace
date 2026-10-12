/** Native functions are installed before this bundle is evaluated. Every callback stays on the JSC run loop. */
export interface NativeHost {
  call(operation: string, input: string, done: (error: string | null, value: string) => void): void;
  emit(patch: string): void;
  socket(id: string, action: string, value: string): void;
  timer(id: string, delay: number, callback: () => void): void;
  cancelTimer(id: string): void;
  now(): number;
  uuid(): string;
  random(): number;
  encode(text: string): number[];
  utf8Base64(text: string): string;
  decode(bytes: number[], encoding: string, fatal: boolean): string;
  randomBytes(count: number): number[];
  base64(text: string, decode: boolean): string;
}
declare global {
  var aceHost: NativeHost;
}
export const host = globalThis.aceHost;
export function call(operation: string, input: unknown = null): Promise<string> {
  return new Promise((resolve, reject) => {
    host.call(operation, JSON.stringify(input), (error, value) => {
      if (error) reject(new Error(error));
      else resolve(value);
    });
  });
}
export const scheduler = {
  set(delay: number, callback: () => void): () => void {
    const id = host.uuid();
    host.timer(id, delay, callback);
    return () => host.cancelTimer(id);
  },
};
