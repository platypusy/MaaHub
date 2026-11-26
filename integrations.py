# -*- coding: utf-8 -*-
"""
与各自动化软件“贯通”的部分：
  · 真实版本：读 exe 文件版本、interface.json、软件自己的日志，而不是文件夹名
  · 配置与任务：读各软件自己的配置文件，列出每套配置里的任务和勾选状态（只读）
  · 运行动态：从日志里解析任务开始/完成/失败事件

支持的格式：
  maa_wpf  MAA 官方界面   config/gui.new.json、resource/version.json、debug/asst.log
  mfa      MFAAvalonia    config/instances/*.json、logs/log-*.log、debug/maafw.log
  mxu      MXU            config/mxu-*.json、debug/maafw.log、debug/日期.log
"""
import ctypes
import glob
import json
import os
import re
import time
from ctypes import wintypes

# ================================================================ 通用读取
def _strip_jsonc(text):
    """去掉 // 和 /* */ 注释以及尾随逗号（忽略字符串内部）"""
    out, i, n = [], 0, len(text)
    in_str = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
        elif c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


_json_cache = {}


def read_jsonc(path):
    """读取 JSON / JSONC，按修改时间缓存；失败返回 None"""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    hit = _json_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    data = None
    for enc in ("utf-8-sig", "gbk"):
        try:
            with open(path, encoding=enc) as f:
                text = f.read()
        except (OSError, UnicodeDecodeError):
            continue
        try:
            data = json.loads(text)
        except ValueError:
            try:
                data = json.loads(_strip_jsonc(text))
            except ValueError:
                data = None
        break
    _json_cache[path] = (mtime, data)
    return data


def file_version(path):
    """读取 exe/dll 的产品版本（去掉 +commit 后缀）；读不到返回空串"""
    ver = ctypes.WinDLL("version")
    size = ver.GetFileVersionInfoSizeW(path, None)
    if not size:
        return ""
    buf = ctypes.create_string_buffer(size)
    if not ver.GetFileVersionInfoW(path, 0, size, buf):
        return ""
    ptr, ln = ctypes.c_void_p(), wintypes.UINT()
    langs = []
    if ver.VerQueryValueW(buf, "\\VarFileInfo\\Translation", ctypes.byref(ptr), ctypes.byref(ln)) and ln.value:
        arr = (wintypes.WORD * (ln.value // 2)).from_address(ptr.value)
        langs = ["%04x%04x" % (arr[i], arr[i + 1]) for i in range(0, len(arr), 2)]
    for lang in langs + ["040904b0", "000004b0"]:
        for key in ("ProductVersion", "FileVersion"):
            if ver.VerQueryValueW(buf, f"\\StringFileInfo\\{lang}\\{key}", ctypes.byref(ptr), ctypes.byref(ln)) and ln.value:
                s = ctypes.wstring_at(ptr.value, ln.value).strip("\x00 ").split("+")[0]
                if s:
                    return s
    return ""


def _norm_ver(v):
    v = str(v or "").strip()
    return v if not v or v[0] in "vV" else "v" + v


def _newest(pattern):
    files = [f for f in glob.glob(pattern) if os.path.isfile(f)]
    return max(files, key=os.path.getmtime) if files else None


def _grep_last(path, regex, max_bytes=4_000_000):
    """在文件末尾 max_bytes 内找最后一个匹配，返回 match 或 None"""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    last = None
    for m in re.finditer(regex, text):
        last = m
    return last


# ================================================================ MaaFramework 项目接口（interface.json）
def pi_interface(folder):
    """合并 interface.json 及其 import 的文件，返回 (interface, tasks, zh 翻译表)"""
    root = read_jsonc(os.path.join(folder, "interface.json"))
    if not isinstance(root, dict):
        return None, [], {}
    tasks = list(root.get("task") or [])
    for rel in root.get("import") or []:
        sub = read_jsonc(os.path.join(folder, rel))
        if isinstance(sub, dict):
            tasks += sub.get("task") or []
    zh = {}
    langs = root.get("languages") or {}
    for key in ("zh_cn", "zh-CN", "zh_CN", "zh-cn", "zh_hans"):
        if key in langs:
            zh = read_jsonc(os.path.join(folder, langs[key])) or {}
            break
    return root, tasks, zh


def tr(text, zh):
    """把 "$key" 形式的文本翻译成中文"""
    if isinstance(text, str) and text.startswith("$"):
        return zh.get(text[1:], text[1:])
    return text or ""


def pi_task_labels(folder):
    """返回 ({任务名: 中文名}, {入口节点: 中文名})"""
    _, tasks, zh = pi_interface(folder)
    by_name, by_entry = {}, {}
    for t in tasks:
        label = tr(t.get("label"), zh) or t.get("name") or ""
        if t.get("name"):
            by_name[t["name"]] = label
        if t.get("entry"):
            by_entry.setdefault(t["entry"], label)
    return by_name, by_entry


# ================================================================ 真实版本
def versions(app):
    """返回 [{"label", "value", "note"}]，第一项是主版本"""
    folder, kind = app["folder"], app["kind"]
    exe = os.path.join(folder, app.get("exe", ""))
    out = []
    info = read_jsonc(os.path.join(folder, "interface.json")) or {}

    if kind == "maa_wpf":
        v = file_version(exe) if os.path.isfile(exe) else ""
        out.append({"label": "程序", "value": _norm_ver(v), "note": "MAA.exe 文件版本"})
        res = read_jsonc(os.path.join(folder, "resource", "version.json")) or {}
        if res.get("last_updated"):
            name = (res.get("activity") or {}).get("name", "")
            out.append({"label": "资源", "value": res["last_updated"][:10],
                        "note": f"resource/version.json · 当期活动「{name}」" if name else "resource/version.json"})
        return [x for x in out if x["value"]]

    if info.get("version"):
        out.append({"label": "本体", "value": _norm_ver(info["version"]),
                    "note": f"{info.get('name') or '资源'} 的版本（interface.json）"})

    if kind == "mfa":
        log = _newest(os.path.join(folder, "logs", "log-*.log"))
        m = _grep_last(log, r"程序版本[:：]\s*(v?[\w.\-]+)") if log else None
        if m:
            out.append({"label": "界面", "value": _norm_ver(m.group(1)), "note": "MFAAvalonia，取自最近一次启动日志"})
    elif kind == "mxu":
        v = file_version(exe) if os.path.isfile(exe) else ""
        if v:
            out.append({"label": "界面", "value": _norm_ver(v), "note": f"MXU（{app.get('exe')} 文件版本）"})
    elif kind == "custom" and os.path.isfile(exe):
        v = file_version(exe)
        if v:
            out.append({"label": "程序", "value": _norm_ver(v), "note": f"{app.get('exe')} 文件版本"})

    if kind in ("mfa", "mxu"):
        m = _grep_last(os.path.join(folder, "debug", "maafw.log"), r"\]\s*Version (v[\w.\-]+)")
        if m:
            out.append({"label": "框架", "value": m.group(1), "note": "MaaFramework，取自 maafw.log"})
    return out


# ================================================================ 配置与任务
MAA_TYPE_NAMES = {
    "StartUp": "开始唤醒", "Recruit": "自动公招", "Infrast": "基建换班", "Fight": "理智作战",
    "Mall": "信用收支", "Award": "领取奖励", "Roguelike": "自动肉鸽", "Reclamation": "生息演算",
    "CloseDown": "关闭游戏", "Copilot": "自动战斗", "Depot": "仓库识别", "OperBox": "干员识别",
    "Custom": "自定义任务", "SingleStep": "单步任务", "VideoRecognition": "视频识别",
}
MAA_STAGE_NAMES = {"Annihilation": "剿灭", "": "当前/上次", "CurrentOrLast": "当前/上次"}
MAA_INFRAST_MODE = {"Normal": "常规", "Rotation": "队列轮换", "Custom": "自定义"}


def _maa_detail(t):
    tt = t.get("TaskType", "")
    if tt == "Fight":
        plan = t.get("StagePlan") or ([t.get("Stage")] if t.get("Stage") is not None else [])
        names = [MAA_STAGE_NAMES.get(s, s) for s in plan]
        return "关卡 " + " → ".join(names) if names else ""
    if tt == "Infrast":
        return MAA_INFRAST_MODE.get(t.get("Mode", ""), t.get("Mode", ""))
    if tt == "Roguelike":
        return " · ".join(x for x in (t.get("Theme", ""), t.get("Mode", "")) if x)
    return ""


def _maa_configs(folder):
    path = os.path.join(folder, "config", "gui.new.json")
    data = read_jsonc(path)
    if not isinstance(data, dict):  # 旧版 MAA 只有 gui.json，且不含任务队列
        old = read_jsonc(os.path.join(folder, "config", "gui.json")) or {}
        return [{"value": k, "label": k, "current": k == old.get("Current"), "groups": []}
                for k in (old.get("Configurations") or {})]
    cur = data.get("Current")
    out = []
    for name, cfg in (data.get("Configurations") or {}).items():
        tasks = [{"name": t.get("Name") or MAA_TYPE_NAMES.get(t.get("TaskType"), t.get("TaskType", "?")),
                  "type": t.get("TaskType", ""), "enabled": bool(t.get("IsEnable")),
                  "detail": _maa_detail(t)} for t in cfg.get("TaskQueue") or []]
        out.append({"value": name, "label": name, "current": name == cur,
                    "groups": [{"title": "任务队列", "tasks": tasks}]})
    return out


def _mfa_configs(folder):
    # MFAAvalonia：-c 选择配置（config.json 即 Default），每个配置下有若干实例（界面上的标签页）
    settings = read_jsonc(os.path.join(folder, "appsettings.json")) or {}
    ids = [i for i in str(settings.get("Instances.Order") or settings.get("Instances.List") or "").split(",") if i]
    if not ids:
        ids = [os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(folder, "config", "instances", "*.json"))]
    groups = []
    for iid in ids:
        inst = read_jsonc(os.path.join(folder, "config", "instances", iid + ".json"))
        if not isinstance(inst, dict):
            continue
        tasks = [{"name": t.get("name", "?"), "type": t.get("entry", ""), "enabled": bool(t.get("default_check")),
                  "detail": ""} for t in inst.get("TaskItems") or []]
        groups.append({"title": f"实例「{inst.get('InstanceName') or iid}」", "tasks": tasks})
    configs = []
    for p in sorted(glob.glob(os.path.join(folder, "config", "*.json"))):
        d = read_jsonc(p)
        if isinstance(d, dict) and "TaskItems" in d:
            stem = os.path.splitext(os.path.basename(p))[0]
            name = "Default" if stem == "config" else stem
            configs.append({"value": name, "label": name, "current": name == "Default",
                            "groups": groups if name == "Default" else []})
    return configs or [{"value": "Default", "label": "Default", "current": True, "groups": groups}]


def _mxu_configs(folder):
    by_name, _ = pi_task_labels(folder)
    out = []
    for p in glob.glob(os.path.join(folder, "config", "mxu-*.json")):
        d = read_jsonc(p) or {}
        last = d.get("lastActiveInstanceId")
        for inst in d.get("instances") or []:
            tasks = []
            for a in inst.get("preActions") or []:
                tasks.append({"name": a.get("customName") or "前置程序", "type": "pre",
                              "enabled": bool(a.get("enabled")), "detail": "前置程序"})
            for t in inst.get("tasks") or []:
                n = t.get("taskName", "?")
                tasks.append({"name": by_name.get(n, n), "type": n, "enabled": bool(t.get("enabled")), "detail": ""})
            detail = " · ".join(x for x in (inst.get("controllerName"), inst.get("resourceName")) if x)
            out.append({"value": inst.get("name", ""), "label": inst.get("name", ""), "current": inst.get("id") == last,
                        "groups": [{"title": f"任务列表（{detail}）" if detail else "任务列表", "tasks": tasks}]})
    return out


def configs(app):
    try:
        if app["kind"] == "maa_wpf":
            return _maa_configs(app["folder"])
        if app["kind"] == "mfa":
            return _mfa_configs(app["folder"])
        if app["kind"] == "mxu":
            return _mxu_configs(app["folder"])
    except Exception:
        pass
    return []


# ================================================================ 日志：主日志与运行动态
def primary_logs(app):
    """按“对用户最有用”排序的日志文件"""
    f, kind = app["folder"], app["kind"]
    j = lambda *p: os.path.join(f, *p)
    pri = []
    if kind == "maa_wpf":
        pri = [j("debug", "asst.log"), j("debug", "gui.log")]
    elif kind == "mfa":
        pri = [_newest(j("logs", "log-*.log")), j("debug", "maafw.log")]
    elif kind == "mxu":
        dated = [x for x in glob.glob(j("debug", "*.log")) if re.match(r"\d{4}-\d\d-\d\d", os.path.basename(x))]
        pri = [max(dated, key=os.path.getmtime) if dated else None, j("debug", "maafw.log"), j("debug", "mxu-tauri.log")]
    return [p for p in pri if p and os.path.isfile(p)]


def activity_source(app):
    """解析任务事件用的日志"""
    f = app["folder"]
    if app["kind"] == "maa_wpf":
        return os.path.join(f, "debug", "asst.log")
    if app["kind"] in ("mfa", "mxu"):
        return os.path.join(f, "debug", "maafw.log")
    return None


_TS = r"^\[(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d)(?:\.\d+)?\]"
RE_MAA = re.compile(_TS + r".*?append_callback \| (TaskChainStart|TaskChainCompleted|TaskChainError|TaskChainStopped|"
                    r"AllTasksCompleted|TaskChainExtraInfo)\s*(\{.*\})?", re.M)
RE_MAA_START = re.compile(_TS + r".*MaaCore Process Start", re.M)
RE_FW_START = re.compile(_TS + r".*?task start:\s*\[cb_detail=(\{.*?\})\]", re.M)
RE_FW_END = re.compile(_TS + r".*?task end:\s*\[cb_detail=(\{.*?\})\]\s*\[ret=(\w+)\]", re.M)


def _ts(s):
    try:
        return time.mktime(time.strptime(s.replace("T", " "), "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        return 0


def _tail_text(path, max_bytes=3_000_000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


_act_cache = {}


def activity(app, since=0):
    """带缓存：日志没变化时直接返回上次结果"""
    src = activity_source(app)
    try:
        st = os.stat(src) if src else None
    except OSError:
        st = None
    key = (app["id"], src, st and st.st_mtime, st and st.st_size, int(since))
    hit = _act_cache.get(app["id"])
    if hit and hit[0] == key:
        return hit[1]
    res = _activity(app, since)
    _act_cache[app["id"]] = (key, res)
    return res


def _activity(app, since=0):
    """
    解析最近的任务事件。返回
      {"events": [{"t", "kind": start|done|fail|stop|all|boot, "text"}], "current": 当前任务名或 None,
       "source": 日志文件名}
    since：只返回该时间之后的事件（运行中传入启动时间）
    """
    src = activity_source(app)
    if not src or not os.path.isfile(src):
        return {"events": [], "current": None, "source": None}
    text = _tail_text(src)
    events = []
    if app["kind"] == "maa_wpf":
        names = {}
        for cfg in _maa_configs(app["folder"]):
            if cfg["current"]:
                for g in cfg["groups"]:
                    for t in g["tasks"]:
                        if t["enabled"]:
                            names.setdefault(t["type"], t["name"])
        for m in RE_MAA_START.finditer(text):
            events.append((m.start(), _ts(m.group(1)), "boot", "MAA 核心已启动"))
        for m in RE_MAA.finditer(text):
            kind, raw = m.group(2), m.group(3) or "{}"
            try:
                chain = json.loads(raw).get("taskchain", "")
            except ValueError:
                chain = ""
            name = names.get(chain) or MAA_TYPE_NAMES.get(chain, chain)
            k = {"TaskChainStart": "start", "TaskChainCompleted": "done", "TaskChainError": "fail",
                 "TaskChainStopped": "stop", "AllTasksCompleted": "all"}.get(kind)
            if not k:
                continue
            txt = {"start": f"开始 {name}", "done": f"完成 {name}", "fail": f"{name} 出错",
                   "stop": f"{name} 已停止", "all": "全部任务完成"}[k]
            events.append((m.start(), _ts(m.group(1)), k, txt))
    else:
        _, by_entry = pi_task_labels(app["folder"])
        by_name, _ = pi_task_labels(app["folder"])
        label = lambda e: by_entry.get(e) or by_name.get(e) or e
        for m in RE_FW_START.finditer(text):
            try:
                e = json.loads(m.group(2)).get("entry", "")
            except ValueError:
                e = ""
            events.append((m.start(), _ts(m.group(1)), "start", f"开始 {label(e)}"))
        for m in RE_FW_END.finditer(text):
            try:
                e = json.loads(m.group(2)).get("entry", "")
            except ValueError:
                e = ""
            ok = m.group(3) == "true"
            events.append((m.start(), _ts(m.group(1)), "done" if ok else "fail",
                           f"完成 {label(e)}" if ok else f"{label(e)} 失败"))
    events.sort(key=lambda x: x[0])
    if not since:  # 没给时间：只取最近一次启动之后的事件
        boots = [i for i, e in enumerate(events) if e[2] == "boot"]
        if boots:
            events = events[boots[-1]:]
    evs = [{"t": t, "kind": k, "text": s} for _, t, k, s in events if t >= since - 5]
    current = None
    for e in evs:
        if e["kind"] == "start":
            current = e["text"][3:]
        elif e["kind"] in ("done", "fail", "stop", "all"):
            current = None
    return {"events": evs[-40:], "current": current, "source": os.path.relpath(src, app["folder"])}
