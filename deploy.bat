@echo off
chcp 65001 >nul
title Hugo Deploy Script

cd /d "%~dp0"
echo ========================================
echo      Hugo Smart Deploy Script
echo ========================================
echo.

:: Check git repo
git rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Not a git repository
    pause
    exit /b 1
)

:: Select deploy mode
echo [SELECT] Choose deploy mode:
echo   1. Deploy ALL content
echo   2. Deploy POSTS only (content/posts/)
echo.
choice /C 12 /N /M "Select [1/2]: "

if errorlevel 2 (
    set "MODE=posts"
    echo [MODE] Deploy POSTS only
) else (
    set "MODE=all"
    echo [MODE] Deploy ALL content
)

echo.

:: Add files based on mode
if "%MODE%"=="posts" (
    echo [ACTION] Adding posts...
    git add content/posts/ >nul 2>&1
) else (
    echo [ACTION] Adding all changes...
    git add -A >nul 2>&1
)

:: Check if there are changes to commit
git diff --cached --quiet >nul 2>&1
if errorlevel 1 (
    echo [ACTION] Committing changes...
    git commit -m "Update" > commit_output.txt 2>&1
    if errorlevel 1 (
        type commit_output.txt
        echo [ERROR] Commit failed, output copied to clipboard
        type commit_output.txt | clip
        del commit_output.txt 2>nul
        pause
        exit /b 1
    )
    del commit_output.txt 2>nul
    echo [OK] Committed
) else (
    echo [INFO] No changes to commit
)

echo.

:: Check remote status
echo [ACTION] Checking remote status...
git fetch origin master > fetch_output.txt 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to fetch remote
    type fetch_output.txt
    echo [ERROR] Error copied to clipboard
    type fetch_output.txt | clip
    del fetch_output.txt 2>nul
    pause
    exit /b 1
)
del fetch_output.txt 2>nul

git rev-list --left-right --count HEAD...origin/master > temp_check.txt 2>&1
if errorlevel 1 (
    echo [INFO] Cannot compare, trying push directly...
    goto PUSH
)

for /f "tokens=1,2" %%a in (temp_check.txt) do (
    set "LOCAL_AHEAD=%%a"
    set "REMOTE_AHEAD=%%b"
)
del temp_check.txt 2>nul

echo [STATUS] Local ahead: %LOCAL_AHEAD%
echo [STATUS] Remote ahead: %REMOTE_AHEAD%
echo.

:: Handle different scenarios
if %LOCAL_AHEAD%==0 if %REMOTE_AHEAD%==0 (
    echo [DONE] Already up to date
    goto DONE
)

if %LOCAL_AHEAD%==0 if %REMOTE_AHEAD% GTR 0 (
    echo [INFO] Remote is ahead of local
    choice /C YN /N /M "Pull remote changes [Y/N]? "
    if errorlevel 2 (
        echo [CANCEL] Cancelled
        goto DONE
    )
    echo [ACTION] Pulling remote changes...
    git pull origin master > pull_output.txt 2>&1
    if errorlevel 1 (
        type pull_output.txt
        echo [ERROR] Pull failed, output copied to clipboard
        type pull_output.txt | clip
        del pull_output.txt 2>nul
        pause
        exit /b 1
    )
    del pull_output.txt 2>nul
    echo [OK] Pulled successfully
    goto DONE
)

if %LOCAL_AHEAD% GTR 0 if %REMOTE_AHEAD%==0 (
    echo [INFO] Local is ahead, ready to push
    goto PUSH
)

if %LOCAL_AHEAD% GTR 0 if %REMOTE_AHEAD% GTR 0 (
    echo [WARN] Conflict detected! Both local and remote have changes
    echo.
    echo [OPTIONS]
    echo   1. Force push (overwrite remote)
    echo   2. Pull and merge
    echo   3. Cancel
    echo.
    choice /C 123 /N /M "Select [1/2/3]: "
    
    if errorlevel 3 (
        echo [CANCEL] Cancelled
        goto DONE
    )
    
    if errorlevel 2 (
        echo [ACTION] Pulling and merging...
        git pull origin master --rebase > pull_output.txt 2>&1
        if errorlevel 1 (
            type pull_output.txt
            echo [ERROR] Merge failed, output copied to clipboard
            type pull_output.txt | clip
            del pull_output.txt 2>nul
            pause
            exit /b 1
        )
        del pull_output.txt 2>nul
        echo [OK] Merged successfully
        goto PUSH
    )
    
    if errorlevel 1 (
        echo [WARN] Force pushing to remote...
        goto PUSH_FORCE
    )
)

:PUSH
echo.
echo [ACTION] Pushing to remote...

:: Try HTTPS first
echo [ACTION] Trying HTTPS...
git push https://github.com/qdx-loop/myblog.git master > push_output.txt 2>&1
if not errorlevel 1 (
    del push_output.txt 2>nul
    echo [OK] HTTPS push success
    goto DEPLOY
)

:: HTTPS failed, try SSH
echo [INFO] HTTPS failed, trying SSH...
git push git@github.com:qdx-loop/myblog.git master > push_output.txt 2>&1
if not errorlevel 1 (
    del push_output.txt 2>nul
    echo [OK] SSH push success
    goto DEPLOY
)

:: Both failed
type push_output.txt
echo [ERROR] Both HTTPS and SSH failed
echo [ERROR] Error output copied to clipboard
 type push_output.txt | clip
del push_output.txt 2>nul
pause
exit /b 1

:PUSH_FORCE
echo.
echo [ACTION] Force pushing to remote...

:: Try HTTPS first
echo [ACTION] Trying HTTPS...
git push -f https://github.com/qdx-loop/myblog.git master > push_output.txt 2>&1
if not errorlevel 1 (
    del push_output.txt 2>nul
    echo [OK] HTTPS force push success
    goto DEPLOY
)

:: HTTPS failed, try SSH
echo [INFO] HTTPS failed, trying SSH...
git push -f git@github.com:qdx-loop/myblog.git master > push_output.txt 2>&1
if not errorlevel 1 (
    del push_output.txt 2>nul
    echo [OK] SSH force push success
    goto DEPLOY
)

:: Both failed
type push_output.txt
echo [ERROR] Both HTTPS and SSH failed
echo [ERROR] Error output copied to clipboard
type push_output.txt | clip
del push_output.txt 2>nul
pause
exit /b 1

:DEPLOY
echo.
echo ========================================
echo        Push Success!
echo ========================================
echo.
echo [INFO] Waiting for Cloudflare Pages...
echo [INFO] Usually takes 1-2 minutes
echo.
echo [URL] https://qdx.dpdns.org/
echo.

:DONE
echo.
echo [DONE] Finished!
echo.
pause
