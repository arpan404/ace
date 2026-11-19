import { execFileSync } from "node:child_process";

/**
 * Windows: the whole primary display as the person sees it, native caption buttons and taskbar
 * included (a page screenshot has neither). PowerShell marks itself DPI aware so the capture is
 * in physical pixels at any scale.
 */
const script = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public static class AceDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][AceDpi]::SetProcessDPIAware()
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save($env:ACE_CAPTURE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
`;

export function captureScreen(path: string): void {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, ACE_CAPTURE_PATH: path },
    stdio: "inherit",
  });
}
