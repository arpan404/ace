; Everything here is per user: no elevation.
; ace-setup.mjs (src/packaging/setup.ts) runs on the app's bundled Node. It writes the `ace`
; command and puts it on the user PATH, stops processes running from $INSTDIR before an update
; or uninstall replaces them, and on uninstall takes back PATH, the command, the login item and
; browser native hosts. The data home (~\.ace) is never removed.
!macro aceSetup command
  ${if} ${FileExists} "$INSTDIR\resources\setup\ace-setup.mjs"
    nsExec::ExecToLog '"$INSTDIR\resources\runtime\node.exe" "$INSTDIR\resources\setup\ace-setup.mjs" ${command}'
    Pop $0
  ${endIf}
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
; Runs in the old version's uninstaller too, before its files are removed: an update stops what
; runs from $INSTDIR so the new files can replace it.
!macro customUnInstall
  ${if} ${isUpdated}
    !insertmacro aceSetup "stop"
  ${else}
    !insertmacro aceSetup "uninstall"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\ace"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ace"
  ${endIf}
!macroend
