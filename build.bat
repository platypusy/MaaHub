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
rem 注意：PyInstaller 会相对 spec 文件所在目录（build\）解析路径，所以图标和 web 用绝对路径
set "ROOT=%~dp0"
.venv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --windowed --name MaaHub ^
    --icon "%ROOT%maahub.ico" --add-data "%ROOT%web;web" --exclude-module tkinter ^
    --distpath dist --workpath build --specpath build app.py || goto :error

rem 便携版只放 exe 和使用说明（排除 requirements.txt）
powershell -NoProfile -Command "$g = Get-ChildItem *.txt | Where-Object Name -ne 'requirements.txt'; Copy-Item $g.FullName dist -Force; $files = @('dist\MaaHub.exe') + ($g | ForEach-Object { Join-Path dist $_.Name }); Compress-Archive -Force -Path $files -DestinationPath dist\MaaHub-portable.zip" || goto :error

echo.
echo 完成：dist\MaaHub.exe 和 dist\MaaHub-portable.zip
exit /b 0

:error
echo 构建失败。
exit /b 1
