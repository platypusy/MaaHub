@echo off
chcp 65001 >nul
rem 一键构建 MaaHub.exe 和便携版压缩包（需要 Python 3.10+）
setlocal
cd /d "%~dp0"

if not exist .venv (
    echo [1/3] 创建虚拟环境...
    python -m venv .venv || goto :error
)

echo [2/3] 安装依赖...
.venv\Scripts\python.exe -m pip install -q -r requirements.txt pyinstaller || goto :error

echo [3/3] 打包...
.venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --windowed --name MaaHub ^
    --icon maahub.ico --add-data "web;web" --exclude-module tkinter ^
    --distpath dist --workpath build --specpath build app.py || goto :error

copy /y 使用说明.txt dist\ >nul
powershell -NoProfile -Command "Compress-Archive -Force -Path dist\MaaHub.exe, dist\使用说明.txt -DestinationPath dist\MaaHub-portable.zip"

echo.
echo 完成：dist\MaaHub.exe 和 dist\MaaHub-portable.zip
exit /b 0

:error
echo 构建失败。
exit /b 1
