@echo off
chcp 65001 >nul
echo ============== 开始一键同步到GitHub ==============

cd /d D:\myblog || (
    echo 错误：找不到博客目录
    pause
    exit /b 1
)

if not exist ".git" (
    echo 错误：不是Git仓库
    pause
    exit /b 1
)

echo 正在添加文件...
git add .

echo 正在提交更改...
git commit -m "自动发布：%date% %time%"

echo 正在推送到GitHub...
git push origin master

echo ============== 同步完成 ==============
pause