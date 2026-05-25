@echo off
powershell -NoProfile -Command "$f = (Get-Item '%~dp0index.html').FullName -replace '\\','/'; Start-Process 'msedge' \"--app=file:///$f\""
