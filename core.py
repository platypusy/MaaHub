# -*- coding: utf-8 -*-
"""
MaaHub 后台逻辑：应用识别、配置读取、启动参数、进程检测、日志、运行记录、顺序执行。
与界面无关，只依赖标准库和 Pillow（用于图标处理）。
"""
import base64
import colorsys
import ctypes
import glob
import io
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import uuid
from ctypes import wintypes

import integrations

if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "maahub_apps.json")


KINDS = {
    "maa_wpf": {"label": "MAA 官方界面", "profile": "配置方案", "autorun": True, "quit": False,
                "hint": "参数 --config <配置名>。关闭“自动执行”会附加 --skip-startup-auto-run；"
                        "“完成后退出”需在 MAA 设置 → 运行设置 中开启。"},
    "mfa": {"label": "MFAAvalonia", "profile": "配置文件", "autorun": False, "quit": False,
            "hint": "参数 -c <配置名称>。自动执行与完成后动作请在该程序自己的设置中配置。"},
    "mxu": {"label": "MXU", "profile": "实例", "autorun": True, "quit": True,
            "hint": "参数 --autostart -i <实例名> [-q]。只有开启“自动执行”时，实例与“完成后退出”才生效。"},
    "custom": {"label": "通用程序", "profile": None, "autorun": False, "quit": False,
               "hint": "直接运行可执行文件，并附加额外参数。"},
}

EXE_BLACKLIST = re.compile(r"(updater|maapicli|uninst|setup|crashpad|dependency)", re.I)
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200

# ================================================================ Windows API
_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_psapi = ctypes.WinDLL("psapi", use_last_error=True)
_k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_k32.OpenProcess.restype = wintypes.HANDLE
_k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                            ctypes.POINTER(wintypes.DWORD)]
_k32.CloseHandle.argtypes = [wintypes.HANDLE]
_psapi.EnumProcesses.argtypes = [ctypes.POINTER(wintypes.DWORD), wintypes.DWORD,
                                 ctypes.POINTER(wintypes.DWORD)]
_k32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
_k32.LoadLibraryExW.restype = wintypes.HMODULE
_k32.FreeLibrary.argtypes = [wintypes.HMODULE]
_k32.FindResourceW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p]
_k32.FindResourceW.restype = ctypes.c_void_p
_k32.LoadResource.argtypes = [wintypes.HMODULE, ctypes.c_void_p]
_k32.LoadResource.restype = ctypes.c_void_p
_k32.LockResource.argtypes = [ctypes.c_void_p]
_k32.LockResource.restype = ctypes.c_void_p
_k32.SizeofResource.argtypes = [wintypes.HMODULE, ctypes.c_void_p]
_k32.SizeofResource.restype = wintypes.DWORD
_ENUMRESNAMEPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p,
                                      ctypes.c_void_p, ctypes.c_void_p)
_k32.EnumResourceNamesW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, _ENUMRESNAMEPROC, ctypes.c_void_p]


def norm(path):
    return os.path.normcase(os.path.abspath(path)) if path else ""


def running_processes():
    """返回 {规范化 exe 路径: [pid, ...]}"""
    arr = (wintypes.DWORD * 8192)()
    needed = wintypes.DWORD()
    if not _psapi.EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(needed)):
        return {}
    result = {}
    buf = ctypes.create_unicode_buffer(2048)
    for pid in arr[: needed.value // ctypes.sizeof(wintypes.DWORD)]:
        if not pid:
            continue
        h = _k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            continue
        try:
            size = wintypes.DWORD(len(buf))
            if _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                result.setdefault(os.path.normcase(buf.value), []).append(pid)
        finally:
            _k32.CloseHandle(h)
    return result


def _resource_bytes(hmod, name, rtype):
    res = _k32.FindResourceW(hmod, name, rtype)
    if not res:
        return None
    size = _k32.SizeofResource(hmod, res)
    ptr = _k32.LockResource(_k32.LoadResource(hmod, res))
    return ctypes.string_at(ptr, size) if ptr and size else None


def exe_icon_bytes(exe):
    """从 exe 的资源里取出最大的图标，返回可被 Pillow 打开的字节（PNG 或 ICO）"""
    hmod = _k32.LoadLibraryExW(exe, None, 0x00000002 | 0x00000020)  # 仅作为资源数据加载
    if not hmod:
        return None
    try:
        names = []
        cb = _ENUMRESNAMEPROC(lambda h, t, name, p: names.append(
            name if name < 0x10000 else ctypes.wstring_at(name)) or True)
        _k32.EnumResourceNamesW(hmod, 14, cb, None)  # RT_GROUP_ICON
        if not names:
            return None
        name = names[0]
        grp = _resource_bytes(hmod, name if isinstance(name, int) else ctypes.c_wchar_p(name), 14)
        if not grp or len(grp) < 6:
            return None
        count = int.from_bytes(grp[4:6], "little")
        best = None
        for i in range(count):
            e = grp[6 + i * 14: 20 + i * 14]
            w = e[0] or 256
            bits = int.from_bytes(e[6:8], "little")
            rid = int.from_bytes(e[12:14], "little")
            if best is None or (w, bits) > best[0]:
                best = ((w, bits), e, rid)
        if not best:
            return None
        data = _resource_bytes(hmod, best[2], 3)  # RT_ICON
        if not data:
            return None
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return data
        # 位图格式：补一个 .ico 文件头
        entry = best[1][:12] + (22).to_bytes(4, "little")
        return b"\x00\x00\x01\x00\x01\x00" + entry + data
    finally:
        _k32.FreeLibrary(hmod)


def is_elevated(pid):
    """该进程是否以管理员身份运行（读进程令牌的 TokenElevation）"""
    h = _k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return True  # 连查询都不允许，按受保护处理
    tok = wintypes.HANDLE()
    try:
        if not ctypes.windll.advapi32.OpenProcessToken(h, 0x0008, ctypes.byref(tok)):  # TOKEN_QUERY
            return True
        val, ret = wintypes.DWORD(), wintypes.DWORD()
        ok = ctypes.windll.advapi32.GetTokenInformation(tok, 20, ctypes.byref(val), 4, ctypes.byref(ret))
        _k32.CloseHandle(tok)
        return bool(ok and val.value)
    finally:
        _k32.CloseHandle(h)


def process_start_time(pid):
    """进程的真实启动时间（Unix 时间戳）；读不到返回 None"""
    h = _k32.OpenProcess(0x1000, False, pid)
    if not h:
        return None
    try:
        t = [wintypes.FILETIME() for _ in range(4)]
        if not _k32.GetProcessTimes(h, *[ctypes.byref(x) for x in t]):
            return None
        v = (t[0].dwHighDateTime << 32) | t[0].dwLowDateTime
        return v / 1e7 - 11644473600
    finally:
        _k32.CloseHandle(h)


def can_terminate(pid):
    """当前权限能否结束该进程：普通权限的 MaaHub 结束不了管理员进程"""
    return is_admin() or not is_elevated(pid)


def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def shell_runas(exe, args, cwd):
    ret = ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, subprocess.list2cmdline(args), cwd, 1)
    if ret <= 32:
        raise OSError(f"以管理员身份启动失败（代码 {ret}），可能是取消了 UAC 提示")


# ================================================================ 识别与读取
def read_json(path):
    for enc in ("utf-8-sig", "gbk"):
        try:
            with open(path, encoding=enc) as f:
                return json.load(f)
        except (OSError, ValueError, UnicodeDecodeError):
            continue
    return None


def list_exes(folder):
    return sorted(os.path.basename(p) for p in glob.glob(os.path.join(folder, "*.exe")))


def candidate_exes(folder):
    exes = list_exes(folder)
    good = [e for e in exes if not EXE_BLACKLIST.search(e)]
    return good or exes


def detect_app(folder):
    """识别目录中的程序类型，返回 (kind, exe)；无法识别返回 (None, None)"""
    if not folder or not os.path.isdir(folder):
        return None, None
    j = lambda *p: os.path.join(folder, *p)
    exes = candidate_exes(folder)
    if os.path.isfile(j("MAA.exe")) and (os.path.isfile(j("MaaCore.dll")) or os.path.isfile(j("config", "gui.json"))):
        return "maa_wpf", "MAA.exe"
    if os.path.isfile(j("MFAAvalonia.dll")) or os.path.isfile(j("MFAAvalonia.exe")):
        others = [e for e in exes if e.lower() != "mfaavalonia.exe"]
        return "mfa", (others or exes or ["MFAAvalonia.exe"])[0]
    if exes and (glob.glob(j("config", "mxu-*.json")) or os.path.isfile(j("interface.json"))):
        exes.sort(key=lambda e: os.path.getsize(j(e)), reverse=True)
        return "mxu", exes[0]
    if exes:
        return "custom", exes[0]
    return None, None


KNOWN_PROJECTS = {  # interface.json 的 name（小写） -> (显示名, 游戏名)
    "maa": ("MAA", "明日方舟"),
    "m9a": ("M9A", "重返未来：1999"),
    "maaend": ("MaaEnd", "明日方舟：终末地"),
}


def suggest_name(folder, kind):
    """给新添加的程序起一个好读的名字，返回 (名称, 副标题)"""
    if kind == "maa_wpf":
        return KNOWN_PROJECTS["maa"]
    info = read_json(os.path.join(folder, "interface.json")) or {}
    raw = str(info.get("name") or "")
    if raw.lower() in KNOWN_PROJECTS:
        return KNOWN_PROJECTS[raw.lower()]
    base = os.path.basename(folder.rstrip("\\/"))
    base = re.sub(r"[-_ ]?(win|windows)?[-_ ]?(x64|x86_64|amd64|arm64)?[-_ ]?v?\d+(\.\d+)+.*$", "", base, flags=re.I)
    return raw or base or "未命名程序", ""


def is_maa_family(folder):
    j = lambda *p: os.path.join(folder, *p)
    return any(os.path.isfile(j(x)) for x in ("interface.json", "MaaCore.dll", "MFAAvalonia.dll"))


def list_profiles(app):
    return [c["value"] for c in integrations.configs(app)]


def build_args(app):
    kind, profile = app["kind"], (app.get("profile") or "").strip()
    args = []
    if kind == "maa_wpf":
        if profile:
            args += ["--config", profile]
        if not app.get("autorun", True):
            args.append("--skip-startup-auto-run")
    elif kind == "mfa":
        if profile:
            args += ["-c", profile]
    elif kind == "mxu":
        if app.get("autorun"):
            args.append("--autostart")
            if profile:
                args += ["-i", profile]
            if app.get("quit_after"):
                args.append("-q")
    extra = (app.get("extra_args") or "").strip()
    if extra:
        try:
            args += [a.strip('"') for a in shlex.split(extra, posix=False)]
        except ValueError:
            args += extra.split()
    return args


def list_logs(app):
    """主日志在前，其余按修改时间排序"""
    folder = app["folder"]
    primary = integrations.primary_logs(app)
    files = []
    for sub in ("debug", "logs", "log"):
        for ext in ("*.log", "*.txt"):
            files += glob.glob(os.path.join(folder, sub, ext))
    files = [f for f in files if os.path.isfile(f) and f not in primary]
    files.sort(key=os.path.getmtime, reverse=True)
    return primary + files


LEVEL_PATTERNS = [
    ("error", re.compile(r"\[(ERR|ERROR|FTL|FATAL|E)\]|\bERROR\b|\bException\b|错误|失败")),
    ("warn", re.compile(r"\[(WRN|WARN|WARNING|W)\]|\bWARN(ING)?\b|警告")),
    ("debug", re.compile(r"\[(DBG|TRC|DEBUG|TRACE|D|T)\]")),
]


def line_level(line):
    for lvl, pat in LEVEL_PATTERNS:
        if pat.search(line):
            return lvl
    return "info"


def tail_lines(path, max_bytes=200_000, max_lines=1500):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read()
    except OSError as e:
        return {"error": str(e), "lines": [], "truncated": False}
    for enc in ("utf-8", "gbk"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = data.decode("utf-8", "replace")
    lines = text.splitlines()
    truncated = size > max_bytes
    if truncated and lines:
        lines = lines[1:]
    if len(lines) > max_lines:
        lines, truncated = lines[-max_lines:], True
    return {"lines": [[line_level(l), l] for l in lines], "truncated": truncated, "size": size}


# ================================================================ 图标与主题色
_icon_cache = {}


def _icon_source(app):
    folder = app["folder"]
    info = read_json(os.path.join(folder, "interface.json")) or {}
    for p in (info.get("icon"), "logo.ico", "logo.png", "icon.ico", "icon.png"):
        if p and os.path.isfile(os.path.join(folder, p)):
            return open(os.path.join(folder, p), "rb").read()
    exe = os.path.join(folder, app.get("exe", ""))
    if os.path.isfile(exe):
        return exe_icon_bytes(exe)
    return None


def accent_from_image(im):
    small = im.convert("RGBA").resize((48, 48))
    best, total = [0.0, 0.0, 0.0], 0.0
    for r, g, b, a in small.getdata():
        if a < 160:
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        w = (s ** 2) * v if v > 0.25 else 0
        best[0] += r * w
        best[1] += g * w
        best[2] += b * w
        total += w
    if total < 1.0:
        return "#6c7bff"
    r, g, b = (c / total / 255 for c in best)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    r, g, b = colorsys.hls_to_rgb(h, min(max(l, 0.45), 0.6), min(max(s, 0.55), 0.85))
    return "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))


def app_icon(app):
    """返回 (data_uri, accent)；结果按目录+exe 缓存"""
    key = (norm(app["folder"]), app.get("exe"))
    if key in _icon_cache:
        return _icon_cache[key]
    uri, accent = None, None
    try:
        raw = _icon_source(app)
        if raw:
            from PIL import Image
            im = Image.open(io.BytesIO(raw))
            if getattr(im, "format", "") == "ICO":
                sizes = sorted(im.info.get("sizes", []), reverse=True)
                if sizes:
                    im.size = sizes[0]
            im = im.convert("RGBA")
            im.thumbnail((256, 256))
            accent = accent_from_image(im)
            buf = io.BytesIO()
            im.save(buf, "PNG")
            uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        pass
    _icon_cache[key] = (uri, accent)
    return uri, accent


# ================================================================ 数据模型
def new_app(name, folder, kind=None, exe=None, subtitle=""):
    if kind is None:
        kind, exe = detect_app(folder)
    return {
        "id": uuid.uuid4().hex[:8],
        "name": name,
        "subtitle": subtitle,
        "folder": folder,
        "exe": exe or "",
        "kind": kind or "custom",
        "profile": "",
        "autorun": kind == "maa_wpf",
        "quit_after": False,
        "extra_args": "",
        "admin": False,
        "in_sequence": True,
        "color": "",
        "history": [],
    }


class Hub:
    """全部运行时状态，线程安全"""

    def __init__(self):
        self.lock = threading.RLock()
        self.apps, self.settings = self._load()
        self.running = {}        # id -> [pid]
        self.locked = {}         # id -> 进程权限更高，无法由 MaaHub 结束
        self.run_started = {}    # id -> 开始时间
        self.events = []         # 给界面的通知
        self.seq = None
        self._stop = threading.Event()
        self.refresh()
        threading.Thread(target=self._monitor, daemon=True).start()

    # ---------- 持久化
    def _load(self):
        data = read_json(CONFIG_PATH)
        if isinstance(data, dict) and isinstance(data.get("apps"), list):
            apps = data["apps"]
            for a in apps:  # 兼容旧版配置
                for k, v in new_app("", "", a.get("kind", "custom"), a.get("exe")).items():
                    a.setdefault(k, v)
                m = re.fullmatch(r"(.+?)（(.+)）", a.get("name", ""))
                if m and not a.get("subtitle"):
                    a["name"], a["subtitle"] = m.group(1), m.group(2)
            return apps, data.get("settings", {})
        return [], {}  # 首次运行：不预置任何应用，由用户自己添加

    def save(self):
        with self.lock:
            tmp = CONFIG_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"version": 2, "apps": self.apps, "settings": self.settings},
                          f, ensure_ascii=False, indent=2)
            os.replace(tmp, CONFIG_PATH)

    def get(self, aid):
        with self.lock:
            a = next((a for a in self.apps if a["id"] == aid), None)
            if a is None:
                raise KeyError("应用不存在")
            return a

    def notify(self, kind, text):
        with self.lock:
            self.events.append({"t": time.time(), "kind": kind, "text": text})
            self.events = self.events[-50:]

    # ---------- 监控
    def exe_path(self, a):
        return os.path.join(a["folder"], a["exe"])

    def refresh(self):
        procs = running_processes()
        changed = False
        with self.lock:
            for a in self.apps:
                pids = procs.get(norm(self.exe_path(a)), [])
                was = bool(self.running.get(a["id"]))
                self.running[a["id"]] = pids
                if pids and not was:
                    starts = [s for s in (process_start_time(p) for p in pids) if s]
                    self.run_started[a["id"]] = min(starts) if starts else time.time()
                    self.locked[a["id"]] = not all(can_terminate(p) for p in pids)
                elif was and not pids:
                    start = self.run_started.pop(a["id"], None)
                    end = time.time()
                    if start:
                        a["history"] = (a.get("history") or [])[-29:] + [{"start": start, "end": end}]
                        changed = True
                    self.notify("info", f"{a['name']} 已退出" +
                                (f"，运行了 {fmt_duration(end - start)}" if start else ""))
        if changed:
            self.save()

    def _monitor(self):
        while not self._stop.wait(1.5):
            try:
                self.refresh()
                self._seq_step()
            except Exception as e:  # 后台线程不能死
                self.notify("error", f"监控出错：{e}")

    # ---------- 启动 / 停止
    def launch(self, aid):
        a = self.get(aid)
        exe = self.exe_path(a)
        if not os.path.isfile(exe):
            raise OSError(f"找不到程序：{exe}")
        args = build_args(a)
        if a.get("admin"):
            shell_runas(exe, args, a["folder"])
        else:
            try:
                subprocess.Popen([exe] + args, cwd=a["folder"], close_fds=True,
                                 creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            except OSError as e:
                if getattr(e, "winerror", None) == 740:  # 需要管理员权限
                    shell_runas(exe, args, a["folder"])
                else:
                    raise
        self.notify("success", f"已启动 {a['name']}")
        return subprocess.list2cmdline([a["exe"]] + args)

    def kill(self, aid, force=False):
        pids = self.running.get(aid) or []
        if not pids:
            return True
        cmd = ["taskkill", "/T"] + (["/F"] if force else [])
        for p in pids:
            cmd += ["/PID", str(p)]
        r = subprocess.run(cmd, capture_output=True, creationflags=CREATE_NO_WINDOW)
        return r.returncode == 0

    def stop(self, aid):
        a = self.get(aid)
        self.kill(aid)

        def later():
            time.sleep(2.5)
            self.refresh()
            if self.running.get(aid):
                if not self.kill(aid, force=True):
                    self.notify("error", f"无法结束 {a['name']}，它可能以管理员身份运行。"
                                         "请以管理员身份运行 MaaHub，或在该程序内手动退出。")
                time.sleep(1)
                self.refresh()
        threading.Thread(target=later, daemon=True).start()

    # ---------- 顺序执行
    def start_sequence(self):
        with self.lock:
            ids = [a["id"] for a in self.apps if a.get("in_sequence")]
            if not ids:
                raise ValueError("没有勾选任何应用")
            self.seq = {
                "active": True, "started": time.time(), "finished": None,
                "steps": [{"id": i, "name": self.get(i)["name"], "state": "wait",
                           "start": None, "end": None, "note": ""} for i in ids],
            }
        self._seq_step()

    def cancel_sequence(self):
        with self.lock:
            if self.seq and self.seq["active"]:
                self.seq["active"] = False
                self.seq["finished"] = time.time()
                for s in self.seq["steps"]:
                    if s["state"] in ("wait", "launching", "running"):
                        s["state"] = "cancel"
                self.notify("info", "已取消顺序执行（已启动的程序不会被关闭）")

    def _seq_step(self):
        with self.lock:
            s = self.seq
            if not s or not s["active"]:
                return
            now = time.time()
            for st in s["steps"]:
                if st["state"] in ("launching", "running"):
                    running = bool(self.running.get(st["id"]))
                    if running:
                        st["state"] = "running"
                        return
                    if st["state"] == "launching" and now - st["start"] < 60:
                        return
                    st["end"] = now
                    if st["state"] == "running":
                        st["state"] = "done"
                    else:
                        st["state"], st["note"] = "fail", "60 秒内没有检测到程序运行"
                    break
            nxt = next((st for st in s["steps"] if st["state"] == "wait"), None)
            if nxt is None:
                s["active"], s["finished"] = False, now
                self.notify("success", "顺序执行已全部完成")
                return
            nxt["start"] = now
            if self.running.get(nxt["id"]):
                nxt["state"], nxt["note"] = "running", "已在运行，等待其退出"
                return
            nxt["state"] = "launching"
        try:
            self.launch(nxt["id"])
        except Exception as e:
            with self.lock:
                nxt["state"], nxt["end"], nxt["note"] = "fail", time.time(), str(e)
            self._seq_step()


def fmt_duration(sec):
    sec = int(sec)
    if sec < 60:
        return f"{sec} 秒"
    if sec < 3600:
        return f"{sec // 60} 分钟"
    return f"{sec // 3600} 小时 {sec % 3600 // 60} 分钟"
