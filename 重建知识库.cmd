@echo off
cd /d "%~dp0"
node tools\build_catalog.mjs
if errorlevel 1 goto failed
node tools\build_offline.mjs
if errorlevel 1 goto failed
echo.
echo Build complete. Refresh the local page to use the updated knowledge.
pause
exit /b 0
:failed
echo.
echo Build failed. Fix the reported JSON field and try again.
pause
exit /b 1
