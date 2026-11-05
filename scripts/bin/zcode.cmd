@echo off
setlocal
set "ZCODE_CJS=%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs"
if not exist "%ZCODE_CJS%" (
  echo [zcode] Bundled CLI not found: %ZCODE_CJS%
  echo [zcode] Install the standalone ZCode CLI, or edit this shim to point at zcode.cjs.
  exit /b 1
)
node "%ZCODE_CJS%" %*
exit /b %ERRORLEVEL%
