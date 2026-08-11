#!/usr/bin/env bash
# ==========================================
# Hugo Smart Deploy Script (Linux/macOS)
# deploy.bat 的 Linux 移植版
# ==========================================
set -u

cd "$(dirname "$0")" || exit 1

HTTPS_URL="${BLOG_HTTPS_URL:-https://github.com/qdx-loop/myblog.git}"
SSH_URL="${BLOG_SSH_URL:-git@github.com:qdx-loop/myblog.git}"

# HTTPS 通道加速失败切换（20 秒低速即放弃，改走 SSH）
GIT_HTTP_TIMEOUT=(-c http.lowSpeedLimit=1 -c http.lowSpeedTime=20)

pause() {
    read -rp "" _dummy
}

# ---------------------------------------------------------------
# 普通推送（先 HTTPS 后 SSH）
# ---------------------------------------------------------------
goto_push() {
    echo
    echo "[ACTION] Pushing to remote..."
    echo "[ACTION] Trying HTTPS..."
    if git push "${GIT_HTTP_TIMEOUT[@]}" "$HTTPS_URL" master > push_output.txt 2>&1; then
        rm -f push_output.txt
        echo "[OK] HTTPS push success"
        goto_deploy
        return 0
    fi
    echo "[INFO] HTTPS failed, trying SSH..."
    if git push "$SSH_URL" master > push_output.txt 2>&1; then
        rm -f push_output.txt
        echo "[OK] SSH push success"
        goto_deploy
        return 0
    fi
    cat push_output.txt
    rm -f push_output.txt
    echo "[ERROR] Both HTTPS and SSH failed"
    echo "[ERROR] Error output shown above"
    pause
    exit 1
}

# ---------------------------------------------------------------
# 强制推送（先 HTTPS 后 SSH）
# ---------------------------------------------------------------
goto_push_force() {
    echo
    echo "[ACTION] Force pushing to remote..."
    echo "[ACTION] Trying HTTPS..."
    if git push -f "${GIT_HTTP_TIMEOUT[@]}" "$HTTPS_URL" master > push_output.txt 2>&1; then
        rm -f push_output.txt
        echo "[OK] HTTPS force push success"
        goto_deploy
        return 0
    fi
    echo "[INFO] HTTPS failed, trying SSH..."
    if git push -f "$SSH_URL" master > push_output.txt 2>&1; then
        rm -f push_output.txt
        echo "[OK] SSH force push success"
        goto_deploy
        return 0
    fi
    cat push_output.txt
    rm -f push_output.txt
    echo "[ERROR] Both HTTPS and SSH failed"
    echo "[ERROR] Error output shown above"
    pause
    exit 1
}

# ---------------------------------------------------------------
# 部署成功
# ---------------------------------------------------------------
goto_deploy() {
    echo
    echo "========================================"
    echo "        Push Success!"
    echo "========================================"
    echo
    echo "[INFO] Waiting for Cloudflare Pages..."
    echo "[INFO] Usually takes 1-2 minutes"
    echo
    echo "[URL] https://lsx.cc.cd/"
    echo
}

goto_done() {
    echo
    echo "[DONE] Finished!"
    echo
    pause
    exit 0
}

# ===============================================================
# 主流程
# ===============================================================

echo "========================================"
echo "     Hugo Smart Deploy Script"
echo "========================================"
echo

# ---------------------------------------------------------------
# 1. 检查 git 仓库
# ---------------------------------------------------------------
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "[ERROR] Not a git repository"
    pause
    exit 1
fi

# ---------------------------------------------------------------
# 2. 选择部署模式
# ---------------------------------------------------------------
echo "[SELECT] Choose deploy mode:"
echo "  1. Deploy ALL content"
echo "  2. Deploy POSTS only (content/posts/)"
echo
read -rp "Select [1/2]: " MODE

if [ "$MODE" = "2" ]; then
    MODE=posts
    echo "[MODE] Deploy POSTS only"
else
    MODE=all
    echo "[MODE] Deploy ALL content"
fi
echo

# ---------------------------------------------------------------
# 3. 按模式暂存文件
# ---------------------------------------------------------------
if [ "$MODE" = "posts" ]; then
    echo "[ACTION] Adding posts..."
    git add content/posts/ >/dev/null 2>&1
else
    echo "[ACTION] Adding all changes..."
    git add -A >/dev/null 2>&1
fi

# ---------------------------------------------------------------
# 4. 有变更则提交
# ---------------------------------------------------------------
if ! git diff --cached --quiet >/dev/null 2>&1; then
    echo "[ACTION] Committing changes..."
    if ! git commit -m "Update" > commit_output.txt 2>&1; then
        cat commit_output.txt
        echo "[ERROR] Commit failed"
        rm -f commit_output.txt
        pause
        exit 1
    fi
    rm -f commit_output.txt
    echo "[OK] Committed"
else
    echo "[INFO] No changes to commit"
fi
echo

# ---------------------------------------------------------------
# 5. 检查远端状态（先 HTTPS 后 SSH）
# ---------------------------------------------------------------
echo "[ACTION] Checking remote status..."

if git fetch "${GIT_HTTP_TIMEOUT[@]}" "$HTTPS_URL" master > fetch_output.txt 2>&1; then
    rm -f fetch_output.txt
    echo "[OK] Fetched via HTTPS"
elif git fetch "$SSH_URL" master > fetch_output.txt 2>&1; then
    rm -f fetch_output.txt
    echo "[OK] Fetched via SSH"
else
    echo "[ERROR] Failed to fetch remote"
    cat fetch_output.txt
    rm -f fetch_output.txt
    echo "[ERROR] Error output shown above"
    pause
    exit 1
fi

# ---------------------------------------------------------------
# 6. 对比本地与远端进度
# ---------------------------------------------------------------
LEFT_RIGHT=$(git rev-list --left-right --count HEAD...FETCH_HEAD 2>temp_check.txt)
RC=$?
rm -f temp_check.txt
if [ $RC -ne 0 ]; then
    echo "[INFO] Cannot compare, trying push directly..."
    goto_push
    exit 0
fi

LOCAL_AHEAD=$(echo "$LEFT_RIGHT" | awk '{print $1}')
REMOTE_AHEAD=$(echo "$LEFT_RIGHT" | awk '{print $2}')

echo "[STATUS] Local ahead: $LOCAL_AHEAD"
echo "[STATUS] Remote ahead: $REMOTE_AHEAD"
echo

# 不同场景处理
if [ "$LOCAL_AHEAD" -eq 0 ] && [ "$REMOTE_AHEAD" -eq 0 ]; then
    echo "[DONE] Already up to date"
    goto_done
fi

if [ "$LOCAL_AHEAD" -eq 0 ] && [ "$REMOTE_AHEAD" -gt 0 ]; then
    echo "[INFO] Remote is ahead of local"
    read -rp "Pull remote changes [Y/N]? " ANSWER
    case "$ANSWER" in
        y|Y|yes|YES)
            echo "[ACTION] Pulling remote changes..."
            if git pull origin master > pull_output.txt 2>&1; then
                rm -f pull_output.txt
                echo "[OK] Pulled successfully"
            else
                cat pull_output.txt
                rm -f pull_output.txt
                echo "[ERROR] Pull failed, output shown above"
                pause
                exit 1
            fi
            goto_done
            ;;
        *)
            echo "[CANCEL] Cancelled"
            goto_done
            ;;
    esac
fi

if [ "$LOCAL_AHEAD" -gt 0 ] && [ "$REMOTE_AHEAD" -eq 0 ]; then
    echo "[INFO] Local is ahead, ready to push"
    goto_push
    exit 0
fi

if [ "$LOCAL_AHEAD" -gt 0 ] && [ "$REMOTE_AHEAD" -gt 0 ]; then
    echo "[WARN] Conflict detected! Both local and remote have changes"
    echo
    echo "[OPTIONS]"
    echo "  1. Force push (overwrite remote)"
    echo "  2. Pull and merge"
    echo "  3. Cancel"
    echo
    read -rp "Select [1/2/3]: " CHOICE

    if [ "$CHOICE" = "3" ]; then
        echo "[CANCEL] Cancelled"
        goto_done
    fi

    if [ "$CHOICE" = "2" ]; then
        echo "[ACTION] Pulling and merging..."
        if git pull origin master --rebase > pull_output.txt 2>&1; then
            rm -f pull_output.txt
            echo "[OK] Merged successfully"
        else
            cat pull_output.txt
            rm -f pull_output.txt
            echo "[ERROR] Merge failed, output shown above"
            pause
            exit 1
        fi
        goto_push
        exit 0
    fi

    if [ "$CHOICE" = "1" ]; then
        echo "[WARN] Force pushing to remote..."
        goto_push_force
        exit 0
    fi

    echo "[CANCEL] Invalid choice, cancelled"
    goto_done
fi

exit 0
