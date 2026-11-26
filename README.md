# MaaHub

一个统一管理游戏自动化脚本的桌面程序，适用于基于 [MaaFramework](https://github.com/MaaXYZ/MaaFramework) / MaaCore 的项目，例如：

- [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights)：明日方舟
- [M9A](https://github.com/MAA1999/M9A)：重返未来：1999
- [MaaEnd](https://github.com/MaaEnd/MaaEnd)：明日方舟：终末地

在一个窗口里统一启动它们，查看各自的配置和任务，追踪运行进度。

> MaaHub 不包含任何自动化脚本，也不修改它们的文件。脚本需要从各自的项目单独下载。

## 功能

- **统一启动**：每个程序一张卡片，一键启动或停止，显示运行状态和时长。
- **真实版本**：从程序文件、`interface.json` 和运行日志里读取版本，不依赖文件夹名。
- **配置与任务**：直接读取各软件自己的配置文件，列出每套配置里的任务和勾选状态（只读）。
- **运行动态**：解析软件日志，实时显示当前正在执行的任务和已完成的任务。
- **顺序执行**：把多个程序排成队列，前一个退出后自动启动下一个。
- **日志查看**：按级别筛选、搜索，自动刷新。
- **自动识别**：扫描文件夹即可找出 MAA 系程序，并自动提取图标和主题色。
- 浅色 / 深色主题，全中文界面。

## 支持的程序类型

| 类型 | 例子 | 启动参数 | 读取的配置 |
|---|---|---|---|
| MAA 官方界面 | MAA | `--config <配置名>` | `config/gui.new.json` |
| MFAAvalonia | M9A | `-c <配置名>` | `config/instances/*.json` |
| MXU | MaaEnd | `--autostart -i <实例名> -q` | `config/mxu-*.json` |
| 通用程序 | 任意 exe | 自定义 | — |

## 下载使用

到 [Releases](../../releases) 下载 `MaaHub-portable.zip`，解压后双击 `MaaHub.exe`，不需要安装。

运行环境：Windows 10 / 11 64 位，需要 [WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)（Windows 11 自带）。

详细用法见 [使用说明.txt](使用说明.txt)。

## 从源码运行

需要 Python 3.10 或以上。

```bat
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python app.py
```

打包成 exe：运行 `build.bat`，生成的文件在 `dist\` 里。

## 项目结构

```
app.py           程序入口，用 pywebview 承载界面，向前端提供接口
core.py          后台逻辑：识别程序、启动停止、进程监控、顺序执行、日志
integrations.py  读取各软件的版本、配置任务，解析运行动态
web/             界面（原生 HTML / CSS / JS，无框架）
使用说明.txt      随便携版分发的说明
build.bat        一键构建
```

应用列表与设置保存在程序同目录的 `maahub_apps.json`，不会上传到仓库。

## 许可证

[MIT](LICENSE)
