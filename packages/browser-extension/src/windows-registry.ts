import { execFile } from "node:child_process";
import { z } from "zod";

export interface RegistryKey {
  key: string;
  view: 32 | 64;
}
export interface WindowsRegistry {
  read(keys: readonly RegistryKey[]): Promise<(string | undefined)[]>;
  write(keys: readonly RegistryKey[], value: string): Promise<void>;
  remove(keys: readonly RegistryKey[], expected: string): Promise<void>;
}

// JSON on stdin carries paths as data. A single bounded process handles both
// registry views, with .NET distinguishing missing keys from access failures.
// https://learn.microsoft.com/dotnet/api/microsoft.win32.registrykey
const script = `
$ErrorActionPreference = 'Stop'
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  $request = $json | ConvertFrom-Json
  $values = @()
  foreach ($item in $request.keys) {
    $view = if ($item.view -eq 32) { [Microsoft.Win32.RegistryView]::Registry32 } else { [Microsoft.Win32.RegistryView]::Registry64 }
    $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    $key = $null
    try {
      if ($request.action -eq 'write') {
        $key = $root.CreateSubKey($item.key)
        $key.SetValue('', [string]$request.value, [Microsoft.Win32.RegistryValueKind]::String)
      } else {
        $key = $root.OpenSubKey($item.key, ($request.action -eq 'remove'))
        $value = $null
        if ($null -ne $key) {
          $value = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          if ($null -ne $value -and $key.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'Native host registry value must be REG_SZ' }
          if ($request.action -eq 'remove' -and $value -ceq $request.value) { $key.DeleteValue('', $false) }
        }
        $values += $value
      }
    } finally {
      if ($null -ne $key) { $key.Dispose() }
      $root.Dispose()
    }
  }
  $json = ConvertTo-Json -InputObject @($values) -Compress
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

async function request(
  action: "read" | "write" | "remove",
  keys: readonly RegistryKey[],
  value?: string,
): Promise<(string | undefined)[]> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { timeout: 10_000, maxBuffer: 65_536, windowsHide: true, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      Buffer.from(JSON.stringify({ action, keys, value }), "utf8").toString("base64"),
    );
  });
  const encoded = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .parse(output);
  const values = z
    .array(z.string().nullable())
    .max(32)
    .parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
  if (action === "read" && values.length !== keys.length)
    throw new Error("Incomplete native host registry response");
  return values.map((entry) => entry ?? undefined);
}

/** Registry access is lazy; importing the extension package never runs PowerShell. */
export const windowsRegistry: WindowsRegistry = {
  read: (keys) => request("read", keys),
  async write(keys, value) {
    await request("write", keys, value);
  },
  async remove(keys, expected) {
    await request("remove", keys, expected);
  },
};
