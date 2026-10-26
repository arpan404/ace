import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export function systemPowerShell(): string {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
}

// Owner-only DACL via documented .NET FileSecurity: current TokenUser owns,
// inheritance disabled and stripped, then one FullControl allow (zero flags,
// FILE_ALL_ACCESS) for the owner. Optional Everyone reader broadens it.
const SET_DACL_PS = [
  "$ErrorActionPreference='Stop'",
  "$p=$env:ACE_PRIVATE_TARGET",
  "$x=$env:ACE_PRIVATE_EXTRA",
  "$a=[System.IO.File]::GetAccessControl($p)",
  "$m=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$a.SetOwner($m)",
  "$a.SetAccessRuleProtection($true,$false)",
  "foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleAll($r)}",
  "$o=[System.Security.AccessControl.FileSystemAccessRule]::new($m,'FullControl','Allow')",
  "$a.AddAccessRule($o)",
  "$everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
  "if($x -eq 'read'){$e=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'ReadAndExecute','Allow');$a.AddAccessRule($e)} elseif($x -eq 'full'){$e=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'FullControl','Allow');$a.AddAccessRule($e)}",
  "[System.IO.File]::SetAccessControl($p,$a)",
].join(";");

export async function secureOwnerOnly(target: string, extra = "none"): Promise<void> {
  await runFile(
    systemPowerShell(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SET_DACL_PS],
    { env: { ...process.env, ACE_PRIVATE_TARGET: target, ACE_PRIVATE_EXTRA: extra } },
  );
}

// Owner precondition only: points the file owner at the current TokenUser
// while leaving the existing DACL (inherited or broad) untouched, so the
// setter-behavior fixtures start from a known owner without pre-securing.
const SET_OWNER_PS = [
  "$ErrorActionPreference='Stop'",
  "$p=$env:ACE_PRIVATE_TARGET",
  "$a=[System.IO.File]::GetAccessControl($p)",
  "$m=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$a.SetOwner($m)",
  "[System.IO.File]::SetAccessControl($p,$a)",
].join(";");

export async function ensureOwner(target: string): Promise<void> {
  await runFile(
    systemPowerShell(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SET_OWNER_PS],
    { env: { ...process.env, ACE_PRIVATE_TARGET: target } },
  );
}

// Give Everyone inheritable read access, so ordinary creation is observably public.
export async function broadenParent(root: string) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$env:ACE_PRIVATE_PARENT",
    "$a=[System.IO.Directory]::GetAccessControl($p)",
    "$a.SetAccessRuleProtection($true,$false)",
    "foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleAll($r)}",
    "$m=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
    "$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'",
    "$owner=[System.Security.AccessControl.FileSystemAccessRule]::new($m,'FullControl',$inherit,'None','Allow')",
    "$reader=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'ReadAndExecute',$inherit,'None','Allow')",
    "$a.AddAccessRule($owner)",
    "$a.AddAccessRule($reader)",
    "[System.IO.Directory]::SetAccessControl($p,$a)",
  ].join(";");
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  await runFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, ACE_PRIVATE_PARENT: root },
  });
}
