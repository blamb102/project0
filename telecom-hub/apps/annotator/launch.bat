@echo off
set "ANNOTATOR_ROOT=%~dp0"
powershell -NoProfile -Command "Invoke-Expression ([System.IO.File]::ReadAllText($env:ANNOTATOR_ROOT + 'launch.ps1'))"
