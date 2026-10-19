@echo off
chcp 65001 >nul
cd /d d:\小游戏
echo ============================================
echo  森林动物卡牌对战 · 一键启动
echo ============================================
echo.
echo [1/4] 清理旧进程（防止端口或隧道被占用）...
taskkill /f /im "森林动物卡牌对战.exe" >nul 2>&1
taskkill /f /im ngrok.exe >nul 2>&1
timeout /t 2 >nul

echo [2/4] 启动游戏服务器...
start "游戏服务器" /min cmd /c ""d:\小游戏\dist\森林动物卡牌对战.exe""
timeout /t 3 >nul

echo [3/4] 启动 ngrok 隧道...
start "ngrok隧道" /min cmd /c ""d:\小游戏\ngrok-bin\ngrok.exe" http --url=catwalk-antitoxic-sloped.ngrok-free.dev 3000 --config "d:\小游戏\ngrok.yml""
timeout /t 6 >nul

echo [4/4] 检查启动结果...
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
set SERVER_OK=%errorlevel%
tasklist /fi "imagename eq ngrok.exe" | findstr /i "ngrok.exe" >nul
set NGROK_OK=%errorlevel%
echo.
echo ============================================
if "%SERVER_OK%"=="0" (echo  游戏服务器：已启动) else (echo  游戏服务器：[失败] 请检查 dist 文件夹里的 exe)
if "%NGROK_OK%"=="0" (echo  ngrok 隧道：已连接) else (echo  ngrok 隧道：[失败] 请检查网络后重开本程序)
echo.
echo  永久链接: https://catwalk-antitoxic-sloped.ngrok-free.dev
echo  把链接发给朋友即可一起玩（手机/电脑都行）
echo  本窗口可以关闭，游戏会继续在后台运行
echo ============================================
echo.
pause
