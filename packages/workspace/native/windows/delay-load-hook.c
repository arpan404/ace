// descriptor.node calls N-API and libuv in the runtime that loaded it. node.lib names that
// runtime `node.exe`, but ace runs its daemon on the same runtime as `ace Service.exe` (ADR
// 0214), where no module of that name is loaded and LoadLibrary fails. The import is delay
// loaded (`/DELAYLOAD:node.exe`), and this hook answers it with the running executable itself,
// whatever its file name, so the add-on binds to the one runtime and libuv in the process.
// Sources: "Delay load hooks" and "Understand the delay load helper function" on
// learn.microsoft.com.
#include <windows.h>
#include <delayimp.h>

static FARPROC WINAPI running_image_for_node(unsigned notification, PDelayLoadInfo info) {
  if (notification != dliNotePreLoadLibrary || info == NULL || info->szDll == NULL) return NULL;
  if (_stricmp(info->szDll, "node.exe") != 0) return NULL;
  return (FARPROC)GetModuleHandleW(NULL);
}

const PfnDliHook __pfnDliNotifyHook2 = running_image_for_node;
