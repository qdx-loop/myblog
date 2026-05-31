@echo off
cd /d D:\myblog
hugo
git add .
git commit -m "Update: %date% %time%"
git push github master
echo 推送完成！
pause