@echo off
cd /d C:\Users\thoma\Documents\executor-browser
echo [fable] local claude-fable-5 design+impl ? cwd=%CD%
claude auth status
if errorlevel 1 (
  echo Auth failed in this shell. Stay in the PowerShell/cmd where `claude` already works.
  exit /b 1
)
claude --model claude-fable-5 --effort high --permission-mode acceptEdits --add-dir "C:\Users\thoma\Documents\tbd\coord\tracks" --max-turns 80 --name "executor-browser-ui-fable-local" "Read design/FABLE-PROMPT.md and execute it fully. Load the frontend-design skill. Work only in this repo for extension code; also update C:\Users\thoma\Documents\tbd\coord\tracks\executor-browser-ui.md when done (QA checklist + job status)."
echo [fable] exit=%ERRORLEVEL%
pause
