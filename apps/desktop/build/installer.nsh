; Everything here is per user: no elevation.
; ace-setup.mjs (src/packaging/setup.ts) runs on the app's bundled Node. It writes the `ace`
; command and puts it on the user PATH, stops processes running from $INSTDIR before an update
; or uninstall replaces them, and on uninstall takes back PATH, the command, the login item and
; browser native hosts. The data home (~\.ace) is never removed.

; electron-builder's own running-app check needs these only when no custom check is defined.
!include "getProcessInfo.nsh"
Var pid

; Runs the installed helper; $0 is its exit code (2: agents are at work, nothing was stopped).
!macro aceSetup command
  StrCpy $0 0
  ${if} ${FileExists} "$INSTDIR\resources\setup\ace-setup.mjs"
    nsExec::ExecToLog '"$INSTDIR\resources\runtime\node.exe" "$INSTDIR\resources\setup\ace-setup.mjs" ${command}'
    Pop $0
  ${endIf}
!macroend

!macro aceRefused
  MessageBox MB_OK|MB_ICONEXCLAMATION "ace is still working on agents. Let them finish or stop them in ace, then run setup again." /SD IDOK
  SetErrorLevel 2
!macroend

; Before electron-builder ends everything running from $INSTDIR: stop ace's daemon cleanly, and
; refuse while agents are at work. An update the app started (--updated) has already drained
; them, so it stops regardless. electron-builder's own check then runs as before.
!macro customCheckAppRunning
  ${if} ${isUpdated}
    !insertmacro aceSetup "force-stop"
  ${else}
    !insertmacro aceSetup "stop"
    ${if} $0 == 2
      !insertmacro aceRefused
      Quit
    ${endIf}
  ${endIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

; "Open in ace" on folders in Explorer (per user, no elevation).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\ace" "" "Open in ace"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ace" "Icon" "$INSTDIR\ace.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ace\command" "" '"$INSTDIR\ace.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ace" "" "Open in ace"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ace" "Icon" "$INSTDIR\ace.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ace\command" "" '"$INSTDIR\ace.exe" "%V"'
  ${if} ${isUpdated}
    !insertmacro aceSetup "update"
  ${else}
    !insertmacro aceSetup "install"
  ${endIf}
!macroend
; Runs in the old version's uninstaller too, before its files are removed: an update (the app's,
; or a reinstall whose installer already checked) stops what runs from $INSTDIR so the new files
; can replace it. A plain uninstall refuses while agents are at work.
!macro customUnInstall
  ${if} ${isUpdated}
    !insertmacro aceSetup "force-stop"
  ${else}
    !insertmacro aceSetup "uninstall"
    ${if} $0 == 2
      !insertmacro aceRefused
      Abort
    ${endIf}
    DeleteRegKey HKCU "Software\Classes\Directory\shell\ace"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ace"
  ${endIf}
!macroend
