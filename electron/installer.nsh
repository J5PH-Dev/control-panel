!macro customInit
  nsExec::ExecToStack 'node --version'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "Node.js is not installed. Would you like to download and install it now?" IDYES download IDNO abort
    abort:
      Abort "Node.js is required to run this application. Installation cancelled."
    download:
      ExecShell "open" "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi"
      MessageBox MB_OK|MB_ICONINFORMATION "Please install Node.js and then run this installer again."
      Abort "Please run the installer again after installing Node.js."
  ${EndIf}
!macroend 

!macro customInstall
  ; Set the icon for desktop shortcut
  SetOutPath "$INSTDIR\resources\app\electron\icons"
  File "${BUILD_RESOURCES_DIR}\..\electron\icons\icon.ico"
  
  ; Set the icon for the main executable and Start Menu
  WriteRegStr HKLM "Software\Classes\Applications\${PRODUCT_FILENAME}.exe\DefaultIcon" "" "$INSTDIR\resources\app\electron\icons\icon.ico"
  
  ; Create desktop shortcut with correct icon
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\resources\app\electron\icons\icon.ico"
  
  ; Create start menu shortcut with correct icon
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\resources\app\electron\icons\icon.ico" 0
  
  ; Write registry keys for proper icon and application paths
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_FILENAME}.exe" "Path" "$INSTDIR"
  
  ; Set application icon in registry
  WriteRegStr HKLM "Software\Classes\${PRODUCT_NAME}\DefaultIcon" "" "$INSTDIR\resources\app\electron\icons\icon.ico"
  WriteRegStr HKLM "Software\Classes\${PRODUCT_NAME}\shell\open\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" "%1"'
  
  ; Force icon cache refresh
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  ; Clean up shortcuts
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"
  
  ; Clean up registry
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_FILENAME}.exe"
  DeleteRegKey HKLM "Software\Classes\Applications\${PRODUCT_FILENAME}.exe"
!macroend 