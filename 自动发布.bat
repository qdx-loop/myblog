@echo off
chcp 65001
echo ====================== 开始发布 ======================
git add .
git commit -m "自动发布：更新文章/配置"
git push origin master
echo.
echo 发布完成！按任意键关闭窗口...
pause >nul