# -*- coding: utf-8 -*-
"""MaaHub 入口：用 pywebview 承载 web/ 下的界面，并把 core.Hub 暴露给前端。"""
import ctypes
import os
import subprocess
import sys
import time

import webview

import core
import integrations

APP_VERSION = "1.1.0"

if getattr(sys, "frozen", False):
    WEB_DIR = os.path.join(sys._MEIPASS, "web")
else:
    WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

EDITABLE = {"name", "subtitle", "profile", "autorun", "quit_after", "extra_args", "admin",
            "in_sequence", "color", "folder", "exe", "kind"}


class Api:
    def __init__(self, hub):
        self._hub = hub
        self._window = None

    # ---------- 视图数据
    def _view(self, a):
        icon, accent = core.app_icon(a)
        k = core.KINDS.get(a["kind"], core.KINDS["custom"])
        hist = a.get("history") or []
        last = hist[-1] if hist else None
        return {
            **{key: a.get(key) for key in EDITABLE | {"id"}},
            "icon": icon,
            "accent": a.get("color") or accent or "#6c7bff",
            "auto_accent": accent or "#6c7bff",
            "kind_label": k["label"],
            "kind_info": k,
            "configs": integrations.configs(a),
            "versions": integrations.versions(a),
            "exe_path": self._hub.exe_path(a),
            "exists": os.path.isfile(self._hub.exe_path(a)),
            "command": subprocess.list2cmdline([a["exe"]] + core.build_args(a)),
            "last_run": last,
            "history": hist[-16:],
            "run_count": len(hist),
        }

    def bootstrap(self):
        h = self._hub
        with h.lock:
            return {
                "apps": [self._view(a) for a in h.apps],
                "kinds": core.KINDS,
                "settings": h.settings,
                "config_path": core.CONFIG_PATH,
                "version": APP_VERSION,
                "is_admin": core.is_admin(),
            }

    def state(self, since=0):
        h = self._hub
        with h.lock:
            return {
                "running": {aid: {"pids": p, "since": h.run_started.get(aid),
                                  "locked": h.locked.get(aid, False),
                                  "current": self._current(aid)}
                            for aid, p in h.running.items() if p},
                "seq": h.seq,
                "events": [e for e in h.events if e["t"] > since],
                "now": time.time(),
            }

    def _current(self, aid):
        try:
            a = self._hub.get(aid)
            return integrations.activity(a, self._hub.run_started.get(aid, 0))["current"]
        except Exception:
            return None

    def activity(self, aid):
        a = self._hub.get(aid)
        since = self._hub.run_started.get(aid, 0) if self._hub.running.get(aid) else 0
        return integrations.activity(a, since)

    def restart_as_admin(self):
        """以管理员身份重新启动 MaaHub"""
        if getattr(sys, "frozen", False):
            exe, args = sys.executable, []
        else:
            exe, args = sys.executable.replace("python.exe", "pythonw.exe"), [os.path.abspath(__file__)]
        core.shell_runas(exe, args, core.BASE_DIR)
        self._window.destroy()
        return True

    # ---------- 修改
    def update(self, aid, fields):
        h = self._hub
        with h.lock:
            a = h.get(aid)
            for k, v in (fields or {}).items():
                if k in EDITABLE:
                    a[k] = v
            h.save()
            return self._view(a)

    def save_app(self, data):
        h = self._hub
        with h.lock:
            if data.get("id"):
                a = h.get(data["id"])
                if data.get("kind") and data["kind"] != a["kind"]:
                    a["profile"] = ""
            else:
                a = core.new_app(data.get("name", ""), data.get("folder", ""),
                                 data.get("kind") or None, data.get("exe") or None)
                h.apps.append(a)
            for k, v in data.items():
                if k in EDITABLE:
                    a[k] = v
            h.save()
        h.refresh()
        return self._view(a)

    def delete(self, aid):
        h = self._hub
        with h.lock:
            h.apps.remove(h.get(aid))
            h.save()
        return True

    def reorder(self, ids):
        h = self._hub
        with h.lock:
            order = {i: n for n, i in enumerate(ids)}
            h.apps.sort(key=lambda a: order.get(a["id"], 1 << 30))
            h.save()
        return True

    def set_setting(self, key, value):
        h = self._hub
        with h.lock:
            h.settings[key] = value
            h.save()
        return True

    # ---------- 运行
    def launch(self, aid):
        return self._hub.launch(aid)

    def stop(self, aid):
        self._hub.stop(aid)
        return True

    def seq_start(self):
        self._hub.start_sequence()
        return True

    def seq_cancel(self):
        self._hub.cancel_sequence()
        return True

    # ---------- 文件与日志
    def open_folder(self, aid):
        os.startfile(self._hub.get(aid)["folder"])
        return True

    def _check_log(self, path):
        p = core.norm(path)
        if not any(p.startswith(core.norm(a["folder"]) + os.sep) for a in self._hub.apps):
            raise PermissionError("只能读取已添加应用目录中的日志")
        return path

    def logs(self, aid):
        a = self._hub.get(aid)
        out = []
        for p in core.list_logs(a):
            try:
                st = os.stat(p)
            except OSError:
                continue
            out.append({"path": p, "name": os.path.relpath(p, a["folder"]),
                        "mtime": st.st_mtime, "size": st.st_size})
        return out

    def read_log(self, path):
        return core.tail_lines(self._check_log(path))

    def open_log_external(self, path):
        subprocess.Popen(["notepad.exe", self._check_log(path)])
        return True

    def pick_folder(self):
        res = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        return os.path.normpath(res[0]) if res else None

    def detect(self, folder):
        kind, exe = core.detect_app(folder)
        name, sub = core.suggest_name(folder, kind) if kind else ("", "")
        return {"kind": kind, "exe": exe, "exes": core.list_exes(folder) if os.path.isdir(folder) else [],
                "name": name, "subtitle": sub}

    def scan(self, root):
        known = {core.norm(a["folder"]) for a in self._hub.apps}
        dirs = [root] + [os.path.join(root, d) for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))]
        found = []
        for d in dirs:
            if core.norm(d) in known or not core.is_maa_family(d):
                continue
            kind, exe = core.detect_app(d)
            if kind:
                name, sub = core.suggest_name(d, kind)
                found.append({"name": name, "subtitle": sub, "folder": os.path.normpath(d),
                              "kind": kind, "exe": exe, "kind_label": core.KINDS[kind]["label"]})
        return found

    def add_many(self, items):
        for it in items:
            self.save_app({k: it.get(k, "") for k in ("name", "subtitle", "folder", "kind", "exe")})
        return True

    def open_url(self, url):
        if url.startswith(("https://", "http://")):
            os.startfile(url)
        return True

    def set_title_theme(self, dark):
        """让 Windows 标题栏跟随深浅色"""
        try:
            hwnd = ctypes.windll.user32.FindWindowW(None, self._window.title)
            val = ctypes.c_int(1 if dark else 0)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(val), ctypes.sizeof(val))
        except Exception:
            pass
        return True


def main():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    hub = core.Hub()
    api = Api(hub)
    win = webview.create_window(
        "MaaHub", os.path.join(WEB_DIR, "index.html"), js_api=api,
        width=1320, height=860, min_size=(1040, 680), background_color="#0f1117",
    )
    api._window = win
    webview.start(debug=os.environ.get("MAAHUB_DEBUG") == "1")


if __name__ == "__main__":
    main()
