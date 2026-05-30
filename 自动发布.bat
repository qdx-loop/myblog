@echo off
chcp 65001 >nul
echo ============== 开始一键同步到GitHub ==============

:: 1. 强制切换到博客根目录（这里改成你自己的路径）
cd /d D:\myblog || (
    echo ❌ 错误：找不到博客目录 D:\myblog
    pause
    exit /b 1
)

:: 2. 检查Git仓库状态
if not exist ".git" (
    echo ❌ 错误：当前目录不是Git仓库
    pause
    exit /b 1
)

:: 3. 添加所有修改
echo 正在添加修改...
git add .

:: 4. 提交（带自动时间戳）
echo 正在提交...
git commit -m "自动发布：%date% %time%"

:: 5. 推送到GitHub（SSH协议，走443端口）
echo 正在推送到GitHub...
git push origin master

echo ============== ✅ 同步完成！ ==============
pause