@echo off
rem Lanzador del bot y el panel para Windows. Lo usan los accesos directos:
rem   lanzador.bat start-bot, stop-bot, start-panel, stop-panel, status, kill, resume
rem Los mensajes los muestra Node (launcher\cli.js). Este archivo queda en ASCII
rem porque la consola de Windows rompe los acentos de los .bat.
setlocal
cd /d "%~dp0..\.."
where node >nul 2>nul
if errorlevel 1 goto sin_node
node launcher\cli.js %*
exit /b %errorlevel%

:sin_node
echo.
echo  ERROR  No se encontro Node.js (el comando "node").
echo         Instala Node.js 22.12 o superior (https://nodejs.org) y vuelve a intentarlo.
echo.
pause
exit /b 1
