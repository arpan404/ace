; "Open in ace" on folders in Explorer (per user, no elevation).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\ace" "" "Open in ace"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ace" "Icon" "$INSTDIR\ace.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ace\command" "" '"$INSTDIR\ace.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ace" "" "Open in ace"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ace" "Icon" "$INSTDIR\ace.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ace\command" "" '"$INSTDIR\ace.exe" "%V"'
!macroend
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ace"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ace"
!macroend
