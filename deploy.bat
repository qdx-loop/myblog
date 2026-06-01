@echo off
chcp 65001 >nul
title Hugo Deploy Script

cd /d "%~dp0"
echo [DIR] %cd%
echo.

git rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Not a git repository
    pause
    exit /b 1
)

for /f "tokens=*" %%a in ('git remote get-url origin 2^>nul') do set "REMOTE_URL=%%a"
echo [REMOTE] %REMOTE_URL%
echo.

git diff --quiet HEAD 2>nul
if errorlevel 1 (
    echo [INFO] Local changes detected
    echo [ACTION] Adding changes...
    git add -A
    set "COMMIT_MSG=Update: %date% %time%"
    echo [ACTION] Committing: %COMMIT_MSG%
    git commit -m "%COMMIT_MSG%" 2>nul
    if errorlevel 1 (
        echo [INFO] No changes to commit
    ) else (
        echo [OK] Committed
    )
) else (
    echo [INFO] No local changes
)

echo.
echo [ACTION] Checking remote...
git fetch origin master 2>nul

git rev-list --left-right --count HEAD...origin/master > temp_check.txt 2>nul
if errorlevel 1 (
    echo [INFO] Cannot check remote, trying push...
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

if %LOCAL_AHEAD%==0 if %REMOTE_AHEAD%==0 (
    echo [DONE] Already up to date
    goto DONE
)

if %LOCAL_AHEAD%==0 if %REMOTE_AHEAD% GTR 0 (
    echo [INFO] Remote is ahead
    choice /C YN /N /M "Pull remote changes [Y/N]? "
    if errorlevel 2 (
        echo [CANCEL] Cancelled
        goto DONE
    )
    echo [ACTION] Pulling...
    git pull origin master
    if errorlevel 1 (
        echo [ERROR] Pull failed, force reset...
        git fetch origin master
        git reset --hard origin/master
        echo [OK] Reset done
    )
    goto DONE
)

if %LOCAL_AHEAD% GTR 0 if %REMOTE_AHEAD%==0 (
    echo [INFO] Pushing local changes...
    goto PUSH
)

if %LOCAL_AHEAD% GTR 0 if %REMOTE_AHEAD% GTR 0 (
    echo [WARN] Conflict detected
    echo [OPTION] 1.Force push  2.Pull merge  3.Cancel
    choice /C 123 /N /M "Select [1/2/3]: "
    
    if errorlevel 3 (
        echo [CANCEL] Cancelled
        goto DONE
    )
    
    if errorlevel 2 (
        echo [ACTION] Pulling and merging...
        git pull origin master --rebase
        if errorlevel 1 (
            echo [ERROR] Merge failed
            pause
            exit /b 1
        )
        goto PUSH
    )
    
    if errorlevel 1 (
        echo [WARN] Force pushing...
        goto PUSH_FORCE
    )
)

:PUSH
echo.
echo [ACTION] Pushing...

echo [ACTION] Trying HTTPS...
git push https://github.com/qdx-loop/myblog.git master 2>nul
if not errorlevel 1 (
    echo [OK] HTTPS push success
    goto DEPLOY
)

echo [INFO] HTTPS failed, trying SSH...
git push git@github.com:qdx-loop/myblog.git master 2>nul
if not errorlevel 1 (
    echo [OK] SSH push success
    goto DEPLOY
)

echo [ERROR] Both HTTPS and SSH failed
echo [INFO] Check network or permissions
pause
exit /b 1

:PUSH_FORCE
echo.
echo [WARN] Force pushing...

echo [ACTION] Trying HTTPS...
git push -f https://github.com/qdx-loop/myblog.git master 2>nul
if not errorlevel 1 (
    echo [OK] HTTPS force push success
    goto DEPLOY
)

echo [INFO] HTTPS failed, trying SSH...
git push -f git@github.com:qdx-loop/myblog.git master 2>nul
if not errorlevel 1 (
    echo [OK] SSH force push success
    goto DEPLOY
)

echo [ERROR] Both HTTPS and SSH failed
echo [INFO] Check network or permissions
pause
exit /b 1

:DEPLOY
echo.
echo ================================
echo      Push Success!
echo ================================
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
