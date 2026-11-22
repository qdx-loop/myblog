"""myblog-console — 本地博客控制台 Flask 应用。

只监听 127.0.0.1，无登录。唯一写盘入口是 resolve()+atomic_write()。
运行期数据（配置/备份/回收站/askpass）全部放在 ~/.config/myblog-console/。
"""

from __future__ import annotations

import argparse
import atexit
import collections
import hashlib
import json
import mimetypes
import os
import re
import signal
import subprocess
import sys
import threading
import time
import tomllib
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from flask import (
    Flask,
    Response,
    jsonify,
    request,
    send_file,
    send_from_directory,
)

import frontmatter as fm
import gitops as g
import toml_edit as te

# ---------------------------------------------------------------------------
# 常量与路径
# ---------------------------------------------------------------------------
ROOT = Path(os.environ.get("MYBLOG_ROOT", "/home/qdx/myblog")).resolve()
HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"

CONFIG_DIR = Path(os.path.expanduser("~/.config/myblog-console"))
CONFIG_FILE = CONFIG_DIR / "config.json"
BACKUP_DIR = CONFIG_DIR / "backups"
TRASH_DIR = CONFIG_DIR / "trash"

HUGO_TOML = "hugo.toml"
SITE_URL = g.SITE_URL

MAX_EDIT_BYTES = 2 * 1024 * 1024  # >2 MiB 视为二进制，不内联编辑
SEARCH_SKIP_DIRS = {".git", "themes", "public", "resources", "node_modules", ".obsidian", ".trae"}

DEFAULT_CONFIG = {
    "port": 8787,
    "root": str(ROOT),
    "github_token": "",
    "trash_keep_days": 30,
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                cfg.update(data)
    except Exception:
        pass
    return cfg


def ensure_config() -> dict:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_FILE.exists():
        CONFIG_FILE.write_text(
            json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.chmod(CONFIG_FILE, 0o600)
    return load_config()


CONFIG = ensure_config()


# ---------------------------------------------------------------------------
# 异常
# ---------------------------------------------------------------------------
class BadPath(Exception):
    pass


class Conflict(Exception):
    def __init__(self, current_etag: str, current_content: str):
        super().__init__("conflict")
        self.current_etag = current_etag
        self.current_content = current_content


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------------------
# 路径解析（唯一入口）
# ---------------------------------------------------------------------------
def resolve(rel: str) -> Path:
    if not rel or rel.startswith("/") or "\x00" in rel or "\\" in rel:
        raise BadPath("非法路径")
    p = (ROOT / rel).resolve()
    if p != ROOT and ROOT not in p.parents:
        raise BadPath("越界路径")
    if p == ROOT or p.relative_to(ROOT).parts[0] == ".git":
        raise BadPath("禁止访问 .git")
    return p


def rel_of(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def atomic_write(p: Path, data: bytes) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.parent / (p.name + ".mbc-tmp")
    tmp.write_bytes(data)
    os.replace(tmp, p)


def etag_of(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()[:16]


def is_binary(data: bytes) -> bool:
    return b"\x00" in data[:8192]


# ---------------------------------------------------------------------------
# Job 运行器
# ---------------------------------------------------------------------------
class Job:
    __slots__ = ("id", "kind", "state", "rc", "lines", "created", "proc", "_lock")

    def __init__(self, jid: str, kind: str):
        self.id = jid
        self.kind = kind
        self.state = "running"
        self.rc = 0
        self.lines: list[str] = []
        self.created = time.time()
        self.proc = None
        self._lock = threading.Lock()

    def log(self, line: str) -> None:
        with self._lock:
            self.lines.append(line)

    def snapshot(self, offset: int) -> dict:
        with self._lock:
            new = self.lines[offset:]
            return {
                "id": self.id,
                "kind": self.kind,
                "state": self.state,
                "rc": self.rc,
                "lines": new,
                "next_offset": offset + len(new),
            }


JOBS: dict[str, Job] = {}
_JOBS_LOCK = threading.Lock()


def start_job(kind: str, fn: Callable[[Job], tuple[str, int] | None]) -> Job:
    jid = uuid.uuid4().hex[:12]
    job = Job(jid, kind)
    with _JOBS_LOCK:
        JOBS[jid] = job
        # 简易回收：超过 50 个的旧 job 删掉
        if len(JOBS) > 50:
            oldest = sorted(JOBS.values(), key=lambda j: j.created)
            for j in oldest[: len(JOBS) - 50]:
                JOBS.pop(j.id, None)

    def runner():
        result = None
        try:
            result = fn(job)
        except Exception as e:  # noqa: BLE001
            job.log(f"[ERROR] {e}")
            job.state = "failed"
            job.rc = 1
            return
        state, rc = result if isinstance(result, tuple) else ("done", 0)
        job.state = state
        job.rc = rc

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    return job


# ---------------------------------------------------------------------------
# Flask 应用
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024
app.config["JSON_AS_ASCII"] = False


@app.before_request
def _guard():
    if request.remote_addr not in {"127.0.0.1", "::1"}:
        return jsonify({"error": "仅允许本机访问"}), 403
    host = (request.host or "").split(":")[0].lower()
    if host not in {"127.0.0.1", "localhost", "::1", "[::1]"}:
        return jsonify({"error": "非法 Host 头"}), 403
    return None


@app.errorhandler(BadPath)
def _bad_path(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(Conflict)
def _conflict(e: Conflict):
    return (
        jsonify(
            {
                "error": "conflict",
                "current_etag": e.current_etag,
                "current_content": e.current_content,
            }
        ),
        409,
    )


@app.errorhandler(ApiError)
def _api_error(e: ApiError):
    return jsonify({"error": e.message}), e.status


@app.errorhandler(400)
def _e400(e):
    return jsonify({"error": "请求无效"}), 400


@app.errorhandler(403)
def _e403(e):
    return jsonify({"error": "禁止访问"}), 403


@app.errorhandler(404)
def _e404(e):
    return jsonify({"error": "未找到"}), 404


@app.errorhandler(409)
def _e409(e):
    return jsonify({"error": "conflict"}), 409


@app.errorhandler(413)
def _e413(e):
    return jsonify({"error": "内容超过 20 MiB 限制"}), 413


@app.errorhandler(500)
def _e500(e):
    return jsonify({"error": "服务器内部错误"}), 500


def _json() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("请求体必须是 JSON 对象")
    return data


def _arg(name: str, default=None):
    v = request.args.get(name)
    return default if v is None else v


# ---------------------------------------------------------------------------
# 静态外壳
# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


# ---------------------------------------------------------------------------
# 步骤 2 — 通用文件 API
# ---------------------------------------------------------------------------
@app.get("/api/tree")
def api_tree():
    rel = _arg("dir", "") or ""
    base = resolve(rel) if rel else ROOT
    if not base.is_dir():
        raise ApiError("不是目录")
    entries = []
    try:
        children = sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        children = []
    for p in children:
        name = p.name
        if rel == "" and name == ".git":
            continue
        if name == ".git":
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        is_dir = p.is_dir()
        binary = False
        if not is_dir:
            binary = _looks_binary(p)
        entries.append(
            {
                "name": name,
                "path": rel_of(p),
                "is_dir": is_dir,
                "size": 0 if is_dir else st.st_size,
                "mtime": int(st.st_mtime),
                "binary": binary,
            }
        )
    return jsonify({"dir": rel, "entries": entries})


def _looks_binary(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            return is_binary(f.read(8192))
    except OSError:
        return True


@app.get("/api/file")
def api_file_get():
    rel = _arg("path", "")
    p = resolve(rel)
    if not p.is_file():
        raise ApiError("文件不存在", 404)
    data = p.read_bytes()
    st = p.stat()
    binary = len(data) > MAX_EDIT_BYTES or is_binary(data)
    content = "" if binary else data.decode("utf-8", errors="replace")
    return jsonify(
        {
            "path": rel,
            "content": content,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
            "etag": etag_of(data),
            "binary": binary,
        }
    )


@app.get("/api/file/download")
def api_file_download():
    rel = _arg("path", "")
    p = resolve(rel)
    if not p.is_file():
        raise ApiError("文件不存在", 404)
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return send_file(p, mimetype=mime, as_attachment=True, download_name=p.name)


@app.put("/api/file")
def api_file_put():
    body = _json()
    rel = body.get("path", "")
    p = resolve(rel)
    if not p.is_file():
        raise ApiError("文件不存在", 404)
    current = p.read_bytes()
    want = body.get("etag")
    if want is not None and want != etag_of(current):
        raise Conflict(
            etag_of(current), current.decode("utf-8", errors="replace")
        )
    content = body.get("content", "")
    if not isinstance(content, str):
        raise ApiError("content 必须是字符串")
    new = content.encode("utf-8")
    atomic_write(p, new)
    return jsonify({"ok": True, "etag": etag_of(new), "mtime": int(p.stat().st_mtime)})


@app.post("/api/file/new")
def api_file_new():
    body = _json()
    rel = body.get("path", "")
    p = resolve(rel)
    if p.exists():
        raise ApiError("目标已存在", 409)
    content = body.get("content", "")
    atomic_write(p, (content or "").encode("utf-8"))
    return jsonify({"ok": True, "path": rel})


@app.post("/api/file/rename")
def api_file_rename():
    body = _json()
    src = resolve(body.get("from", ""))
    dst = resolve(body.get("to", ""))
    if not src.exists():
        raise ApiError("源不存在", 404)
    if dst.exists():
        raise ApiError("目标已存在", 409)
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return jsonify({"ok": True, "to": rel_of(dst)})


@app.post("/api/file/delete")
def api_file_delete():
    body = _json()
    rel = body.get("path", "")
    p = resolve(rel)
    if not p.exists():
        raise ApiError("路径不存在", 404)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = TRASH_DIR / ts / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    # 目录或文件整体移入回收站
    os.replace(p, dest) if p.is_file() else _move_tree(p, dest)
    _prune_trash()
    return jsonify({"ok": True, "trashed": str(dest)})


def _move_tree(src: Path, dest: Path) -> None:
    import shutil

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))


def _prune_trash() -> None:
    keep = int(CONFIG.get("trash_keep_days", 30) or 0)
    if keep <= 0:
        return
    cutoff = time.time() - keep * 86400
    try:
        for d in TRASH_DIR.iterdir():
            if d.is_dir() and d.stat().st_mtime < cutoff:
                import shutil

                shutil.rmtree(d, ignore_errors=True)
    except OSError:
        pass


@app.get("/api/search")
def api_search():
    q = (_arg("q", "") or "").strip()
    limit = int(_arg("limit", 50) or 50)
    if not q:
        return jsonify({"hits": []})
    ql = q.lower()
    hits = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SEARCH_SKIP_DIRS]
        for fn in filenames:
            if len(hits) >= limit:
                break
            p = Path(dirpath) / fn
            try:
                if p.stat().st_size > 1024 * 1024:
                    continue
                with p.open("rb") as f:
                    raw = f.read()
                if is_binary(raw):
                    continue
                text = raw.decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            rel = rel_of(p)
            for i, line in enumerate(text.split("\n"), 1):
                if ql in line.lower():
                    hits.append({"path": rel, "line": i, "text": line[:400]})
                    if len(hits) >= limit:
                        break
    return jsonify({"hits": hits[:limit]})


# ---------------------------------------------------------------------------
# 步骤 3 — 文章管理
# ---------------------------------------------------------------------------
def _post_files() -> list[Path]:
    posts_dir = ROOT / "content" / "posts"
    if not posts_dir.is_dir():
        return []
    return sorted(posts_dir.rglob("*.md"))


def _wordcount(body: str) -> int:
    # 中日韩按字计，英文按词计
    cjk = len(re.findall(r"[\u4e00-\u9fff]", body))
    latin = len(re.findall(r"[A-Za-z0-9]+", body))
    return cjk + latin


@app.get("/api/posts")
def api_posts():
    out = []
    for p in _post_files():
        rel = rel_of(p)
        try:
            raw = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        meta, body, has = fm.parse(raw)
        st = p.stat()
        title = str(meta.get("title") or p.stem)
        date = meta.get("date") or ""
        out.append(
            {
                "path": rel,
                "title": title,
                "date": str(date),
                "draft": bool(meta.get("draft", False)),
                "tags": meta.get("tags") or [],
                "categories": meta.get("categories") or [],
                "weight": meta.get("weight", 0),
                "summary": (meta.get("description") or body.strip()[:120]).strip(),
                "wordcount": _wordcount(body),
                "size": st.st_size,
                "mtime": int(st.st_mtime),
            }
        )
    return jsonify(out)


@app.get("/api/post")
def api_post_get():
    rel = _arg("path", "")
    p = resolve(rel)
    if not p.is_file():
        raise ApiError("文章不存在", 404)
    raw_bytes = p.read_bytes()
    raw = raw_bytes.decode("utf-8", errors="replace")
    meta, body, _ = fm.parse(raw)
    return jsonify(
        {
            "path": rel,
            "meta": meta,
            "body": body,
            "raw": raw,
            "etag": etag_of(raw_bytes),
            "mtime": int(p.stat().st_mtime),
        }
    )


@app.put("/api/post")
def api_post_put():
    body = _json()
    rel = body.get("path", "")
    p = resolve(rel)
    if not p.is_file():
        raise ApiError("文章不存在", 404)
    current = p.read_bytes()
    want = body.get("etag")
    if want is not None and want != etag_of(current):
        raise Conflict(
            etag_of(current), current.decode("utf-8", errors="replace")
        )
    meta = body.get("meta")
    if not isinstance(meta, dict):
        raise ApiError("meta 必须是对象")
    content = body.get("body", "")
    if not isinstance(content, str):
        raise ApiError("body 必须是字符串")
    text = fm.emit(meta, content)
    data = text.encode("utf-8")
    atomic_write(p, data)
    return jsonify({"ok": True, "etag": etag_of(data), "mtime": int(p.stat().st_mtime)})


@app.post("/api/post/new")
def api_post_new():
    body = _json()
    title = str(body.get("title", "") or "").strip()
    if not title:
        raise ApiError("标题不能为空")
    tags = body.get("tags") or []
    categories = body.get("categories") or []
    description = str(body.get("description", "") or "")
    draft = bool(body.get("draft", False))
    filename = str(body.get("filename", "") or "").strip()

    slug = fm.slugify(filename) if filename else fm.slugify(title)
    if not slug:
        slug = "post-" + datetime.now().strftime("%Y%m%d%H%M%S")

    posts_dir = ROOT / "content" / "posts"
    posts_dir.mkdir(parents=True, exist_ok=True)

    # 现有最大 weight + 1（最小 1）
    max_w = 0
    for p in _post_files():
        try:
            meta, _, has = fm.parse(p.read_text(encoding="utf-8"))
            if has and isinstance(meta.get("weight"), int):
                max_w = max(max_w, meta["weight"])
        except Exception:
            pass
    weight = max(max_w + 1, 1)

    # 冲突追加 -2, -3 ...
    target = posts_dir / f"{slug}.md"
    n = 2
    while target.exists():
        target = posts_dir / f"{slug}-{n}.md"
        n += 1

    meta = fm.new_meta(title, weight, tags, categories, description, draft)
    atomic_write(target, fm.emit(meta, "").encode("utf-8"))
    return jsonify({"ok": True, "path": rel_of(target)})


@app.get("/api/meta")
def api_meta():
    tags, cats, weights = set(), set(), set()
    for p in _post_files():
        try:
            meta, _, has = fm.parse(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not has:
            continue
        for t in meta.get("tags") or []:
            if t:
                tags.add(str(t))
        for c in meta.get("categories") or []:
            if c:
                cats.add(str(c))
        if isinstance(meta.get("weight"), int):
            weights.add(meta["weight"])
    return jsonify(
        {
            "tags": sorted(tags),
            "categories": sorted(cats),
            "weights": sorted(weights),
        }
    )


# ---------------------------------------------------------------------------
# 步骤 4 — 图片上传
# ---------------------------------------------------------------------------
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._\u4e00-\u9fff-]")


@app.post("/api/upload")
def api_upload():
    if "file" not in request.files:
        raise ApiError("缺少 file 字段")
    f = request.files["file"]
    if not f or not f.filename:
        raise ApiError("空文件")
    custom_dir = (request.form.get("dir") or "").strip()
    now = datetime.now()
    if custom_dir:
        reldir = custom_dir.strip("/")
    else:
        reldir = f"static/images/{now:%Y}/{now:%m}"
    dest_dir = resolve(reldir) if reldir else ROOT
    dest_dir.mkdir(parents=True, exist_ok=True)

    name = f.filename.replace("\\", "/").split("/")[-1]
    stem, ext = os.path.splitext(name)
    stem = _SAFE_NAME.sub("_", stem) or "image"
    ext = ext.lower() or ".png"
    if not ext.startswith("."):
        ext = "." + ext
    base = stem + ext
    target = dest_dir / base
    n = 2
    while target.exists():
        target = dest_dir / f"{stem}-{n}{ext}"
        n += 1

    f.save(str(target))
    rel = rel_of(target)
    # static/ 下的文件按站点根发布
    if rel.startswith("static/"):
        url = "/" + rel[len("static/") :]
    else:
        url = "/" + rel
    md = f"![{stem}]({url})"
    return jsonify({"ok": True, "path": rel, "url": url, "markdown": md})


# ---------------------------------------------------------------------------
# 步骤 5 — 设置面板
# ---------------------------------------------------------------------------
# 表单键 → (表, 键, 类型, 转换函数)
SETTINGS_MAP: list[tuple[str, str, str, str, Callable]] = [
    ("title", "", "title", "str", str),
    ("baseURL", "", "baseURL", "str", str),
    ("locale", "", "locale", "str", str),
    ("theme", "", "theme", "str", str),
    ("author", "params", "author", "str", str),
    ("defaultTheme", "params", "defaultTheme", "str", str),
    ("dateFormat", "params", "dateFormat", "str", str),
    ("ShowReadingTime", "params", "ShowReadingTime", "bool", bool),
    ("ShowShareButtons", "params", "ShowShareButtons", "bool", bool),
    ("ShowPostNavLinks", "params", "ShowPostNavLinks", "bool", bool),
    ("ShowBreadCrumbs", "params", "ShowBreadCrumbs", "bool", bool),
    ("comments", "params", "comments", "bool", bool),
    ("enableSearch", "params", "enableSearch", "bool", bool),
    ("homeTitle", "params.homeInfoParams", "Title", "str", str),
    ("homeContent", "params.homeInfoParams", "Content", "str", str),
    ("searchEnable", "params.search", "enable", "bool", bool),
    ("searchLimit", "params.search", "limit", "int", int),
    ("fuseKeys", "params.search.fuseOpts", "keys", "array", list),
    ("fuseThreshold", "params.search.fuseOpts", "threshold", "float", float),
    ("fuseLocation", "params.search.fuseOpts", "location", "int", int),
    ("fuseDistance", "params.search.fuseOpts", "distance", "int", int),
    ("walineEnable", "params.waline", "enable", "bool", bool),
    ("walineServer", "params.waline", "serverURL", "str", str),
    ("walinePlaceholder", "params.waline", "placeholder", "str", str),
    ("walineLogin", "params.waline", "login", "str", str),
    ("walineRequiredMeta", "params.waline", "requiredMeta", "array", list),
    ("walineWordLimit", "params.waline", "wordLimit", "int", int),
    ("walinePageSize", "params.waline", "pageSize", "int", int),
    ("walineUpload", "params.waline", "upload", "bool", bool),
    ("walineEmoji", "params.waline", "emoji", "bool", bool),
]


def _dig(parsed: dict, table: str, key: str):
    node = parsed
    if table:
        for part in table.split("."):
            if not isinstance(node, dict) or part not in node:
                return None
            node = node[part]
    if isinstance(node, dict):
        return node.get(key)
    return None


def _read_toml() -> tuple[str, dict]:
    p = resolve(HUGO_TOML)
    if not p.is_file():
        raise ApiError("找不到 hugo.toml", 404)
    raw = p.read_text(encoding="utf-8")
    parsed = tomllib.loads(raw)
    return raw, parsed


def _build_form(parsed: dict) -> dict:
    form = {}
    for fk, table, key, kind, conv in SETTINGS_MAP:
        v = _dig(parsed, table, key)
        if v is None:
            v = {"str": "", "bool": False, "int": 0, "float": 0.0, "array": []}[kind]
        form[fk] = v
    return form


def _build_menu(parsed: dict) -> list[dict]:
    items = _dig(parsed, "menu", "main") or []
    out = []
    for it in items:
        if isinstance(it, dict):
            out.append(
                {
                    "identifier": str(it.get("identifier", "")),
                    "name": str(it.get("name", "")),
                    "url": str(it.get("url", "")),
                    "weight": it.get("weight", 0),
                }
            )
    return out


@app.get("/api/settings")
def api_settings_get():
    raw, parsed = _read_toml()
    return jsonify(
        {
            "raw": raw,
            "parsed": parsed,
            "form": _build_form(parsed),
            "menu": _build_menu(parsed),
            "readonly": {
                "outputs.home": _dig(parsed, "outputs", "home") or [],
                "mainSections": _dig(parsed, "params", "mainSections") or [],
            },
        }
    )


def _norm_value(kind: str, conv, v):
    """把表单值与解析值归一到同一可比形式。"""
    if kind == "array":
        return [str(x) for x in (v or [])]
    if kind == "bool":
        return bool(v)
    if kind in ("int", "float"):
        try:
            return conv(v)
        except (ValueError, TypeError):
            return v
    return "" if v is None else str(v)


def _apply_form(raw: str, values: dict, menu) -> str:
    try:
        current = tomllib.loads(raw)
    except tomllib.TOMLDecodeError as e:
        raise ApiError(f"当前 hugo.toml 已损坏，无法表单写入: line {e.lineno}: {e.msg}")
    t = raw
    for fk, table, key, kind, conv in SETTINGS_MAP:
        if fk not in values:
            continue
        want = _norm_value(kind, conv, values[fk])
        got = _norm_value(kind, conv, _dig(current, table, key))
        if want == got:
            # 值未变：跳过写入，避免把误置于别处的键搬动或churn
            continue
        v = values[fk]
        try:
            if kind == "array":
                t = te.set_array(t, table, key, [str(x) for x in (v or [])])
            else:
                t = te.set_value(t, table, key, conv(v))
        except te.TomlEditError as e:
            raise ApiError(f"设置写入失败（{fk}）：{e}")
        except (ValueError, TypeError) as e:
            raise ApiError(f"设置 {fk} 的值非法：{e}")
    if menu is not None:
        if not isinstance(menu, list):
            raise ApiError("menu 必须是数组")
        t = te.replace_menu(t, menu)
    return t


def _backup_hugo_toml() -> str:
    p = resolve(HUGO_TOML)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"hugo.toml.{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    (BACKUP_DIR / name).write_bytes(p.read_bytes())
    return name


def _verify_form(parsed: dict, values: dict) -> None:
    """写后校验：解析出的每个提交键值必须与提交值一致，防止正则改错行。

    注意：_apply_form 跳过了未变化的键，所以这里也只校验真正写入的键。
    """
    for fk, table, key, kind, conv in SETTINGS_MAP:
        if fk not in values:
            continue
        want_v = _norm_value(kind, conv, values[fk])
        got_v = _norm_value(kind, conv, _dig(parsed, table, key))
        if want_v != got_v:
            raise ApiError(f"设置校验失败：{fk} 期望 {want_v!r} 实际 {got_v!r}")


@app.put("/api/settings")
def api_settings_put():
    body = _json()
    mode = body.get("mode", "form")
    raw, _ = _read_toml()

    if mode == "raw":
        new_text = body.get("raw", "")
        if not isinstance(new_text, str):
            raise ApiError("raw 必须是字符串")
        values, menu = None, None
    elif mode == "form":
        values = body.get("values")
        if not isinstance(values, dict):
            raise ApiError("values 必须是对象")
        menu = body.get("menu")
        new_text = _apply_form(raw, values, menu)
    else:
        raise ApiError("mode 必须是 form 或 raw")

    try:
        parsed = te.check(new_text)
    except tomllib.TOMLDecodeError as e:
        raise ApiError(f"TOML 解析失败: line {e.lineno} col {e.colno}: {e.msg}")

    if values is not None:
        _verify_form(parsed, values)

    if new_text == raw:
        # 完全无变化：不备份、不写盘
        return jsonify({"ok": True, "raw": raw, "parsed": parsed, "backup": None})

    backup = _backup_hugo_toml()
    p = resolve(HUGO_TOML)
    atomic_write(p, new_text.encode("utf-8"))
    return jsonify({"ok": True, "raw": new_text, "parsed": parsed, "backup": backup})


@app.get("/api/settings/backups")
def api_settings_backups():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(BACKUP_DIR.glob("hugo.toml.*"), reverse=True):
        st = p.stat()
        out.append({"name": p.name, "size": st.st_size, "mtime": int(st.st_mtime)})
    return jsonify(out)


@app.post("/api/settings/restore")
def api_settings_restore():
    body = _json()
    name = body.get("name", "")
    if "/" in name or "\\" in name or name in {".", ".."} or not name.startswith("hugo.toml."):
        raise BadPath("非法备份名")
    src = BACKUP_DIR / name
    if not src.is_file():
        raise ApiError("备份不存在", 404)
    _backup_hugo_toml()  # 先备份当前
    raw = src.read_text(encoding="utf-8")
    try:
        parsed = tomllib.loads(raw)
    except tomllib.TOMLDecodeError as e:
        raise ApiError(f"备份文件损坏: {e}")
    p = resolve(HUGO_TOML)
    atomic_write(p, raw.encode("utf-8"))
    return jsonify({"ok": True, "raw": raw, "parsed": parsed})


@app.post("/api/hugo/check")
def api_hugo_check():
    body = _json()
    raw = body.get("raw", "")
    if not isinstance(raw, str):
        raise ApiError("raw 必须是字符串")
    try:
        tomllib.loads(raw)
        return jsonify({"ok": True, "error": ""})
    except tomllib.TOMLDecodeError as e:
        return jsonify({"ok": False, "error": f"line {e.lineno} col {e.colno}: {e.msg}"})


# ---------------------------------------------------------------------------
# 步骤 6 — Git / 发布
# ---------------------------------------------------------------------------
@app.get("/api/status")
def api_status():
    posts = _post_files()
    drafts = 0
    for p in posts:
        try:
            meta, _, has = fm.parse(p.read_text(encoding="utf-8"))
            if has and meta.get("draft"):
                drafts += 1
        except Exception:
            pass
    ab = g.ahead_behind()
    lc = g.log_recent(1)
    title = ""
    try:
        _, parsed = _read_toml()
        title = parsed.get("title", "")
    except Exception:
        pass
    return jsonify(
        {
            "branch": g.branch(),
            "dirty": g.status_porcelain(),
            "ahead": ab.get("ahead"),
            "behind": ab.get("behind"),
            "ref": ab.get("ref"),
            "last_commit": lc[0] if lc else None,
            "hugo": g.hugo_version(),
            "posts": len(posts),
            "drafts": drafts,
            "site_url": SITE_URL,
            "site_title": title,
            "preview": {
                "running": PREVIEW["proc"] is not None,
                "url": PREVIEW["url"],
            },
            "root": str(ROOT),
        }
    )


@app.get("/api/git/log")
def api_git_log():
    limit = int(_arg("limit", 20) or 20)
    return jsonify(g.log_recent(min(max(limit, 1), 200)))


@app.get("/api/git/diff")
def api_git_diff():
    path = _arg("path") or None
    staged = _arg("staged", "0") in ("1", "true", "yes")
    return jsonify({"diff": g.diff_text(path, staged)})


@app.get("/api/git/show")
def api_git_show():
    rev = _arg("rev", "")
    if not rev:
        raise ApiError("缺少 rev")
    return jsonify({"text": g.show_commit(rev)})


@app.post("/api/git/restore")
def api_git_restore():
    body = _json()
    rel = body.get("path", "")
    resolve(rel)  # 越界校验
    rc, out = g.restore_file(rel)
    if rc != 0:
        raise ApiError(out or "回滚失败")
    return jsonify({"ok": True, "message": out})


@app.post("/api/job/test-remote")
def api_job_test_remote():
    token = CONFIG.get("github_token") or None

    def fn(job: Job):
        job.log("[TEST] 开始连通性测试（仅 --dry-run，不改远端）")
        ok, code = g.fetch_test(job.log, token)
        if ok:
            job.log("[OK] 至少一条传输可用")
            return "done", 0
        job.log("[ERROR] 所有传输均不可用")
        return "failed", code

    job = start_job("test-remote", fn)
    return jsonify({"id": job.id})


@app.post("/api/job/publish")
def api_job_publish():
    body = _json()
    message = str(body.get("message") or "Update")
    scope = body.get("scope", "posts")
    if scope not in {"posts", "all"}:
        raise ApiError("scope 必须是 posts 或 all")
    skip_build = bool(body.get("skip_build", False))
    force_build = bool(body.get("force_build", False))
    include_sub = bool(body.get("include_submodule", False))
    dry_run = bool(body.get("dry_run", False))
    mode = body.get("mode", "normal")
    if mode not in {"normal", "pull-rebase", "force"}:
        raise ApiError("mode 非法")
    token = CONFIG.get("github_token") or None

    def fn(job: Job):
        def on_proc(p):
            job.proc = p

        # 1) status
        job.log("[STATUS] git status")
        dirty = g.status_porcelain()
        if not dirty:
            job.log("    (工作区干净)")
        for it in dirty:
            job.log(f"    {it['xy']} {it['path']}")
        sub_changed = any("themes/PaperMod" in it["path"] for it in dirty)
        if sub_changed and not include_sub:
            job.log("[WARN] 检测到主题子模块指针变更，将不纳入本次提交")

        # 2) pull-rebase
        if mode == "pull-rebase":
            job.log("[PULL] git pull --rebase")
            ok, rc, out = g.pull_rebase(job.log, token)
            if not ok:
                job.log("[ERROR] 拉取合并失败")
                if "CONFLICT" in out:
                    job.log("[HINT] 存在冲突，请手动解决后执行 git rebase --continue，或 git rebase --abort 放弃")
                return "failed", rc

        # 3) build check
        if mode == "normal" and not skip_build:
            if g.build_check(job.log, force_build) != 0:
                return "failed", 1

        # 4) stage
        if scope == "posts":
            job.log("[ADD] git add -A -- content/posts")
            rc, out = g.run(["git", "add", "-A", "--", "content/posts"])
        else:
            job.log("[ADD] git add -A")
            rc, out = g.run(["git", "add", "-A"])
            if not include_sub:
                job.log("[ADD] git restore --staged themes/PaperMod")
                g.run(["git", "restore", "--staged", "themes/PaperMod"])
        if rc != 0:
            job.log(f"[ERROR] 暂存失败: {out}")
            return "failed", rc

        # 5) commit
        rc, staged = g.run(["git", "diff", "--cached", "--name-only"])
        staged_files = [l for l in staged.split("\n") if l.strip()]
        if not staged_files:
            job.log("[INFO] 无待提交变更，跳到推送步骤（只推已有本地提交）")
        else:
            job.log(f"[COMMIT] {len(staged_files)} 个文件: {message}")
            rc, out = g.run(["git", "commit", "-m", message])
            for line in out.split("\n"):
                job.log("    " + line)
            if rc != 0:
                job.log("[ERROR] 提交失败")
                return "failed", rc
            rc, out = g.run(["git", "show", "--stat", "--oneline", "HEAD"])
            for line in out.split("\n")[:20]:
                job.log("    " + line)

        # 7) push
        if mode == "force":
            job.log("[PUSH] 强制推送 (force)")
            ok, code = g.push(job.log, dry_run=False, force=True, token=token, on_proc=on_proc)
        else:
            job.log(f"[PUSH] {'演练 (dry-run) ' if dry_run else ''}推送 master")
            ok, code = g.push(job.log, dry_run=dry_run, force=False, token=token, on_proc=on_proc)

        # 8) result
        if ok:
            if dry_run and mode != "force":
                job.log("[INFO] 演练模式：未改动远端")
            else:
                job.log("[INFO] Cloudflare Pages 构建中，通常 1-2 分钟")
                job.log(f"[URL] {SITE_URL}")
            return "done", 0
        if code == 2:
            job.log("[HINT] 非快进冲突：可点击「拉取合并」或「强制推送」")
            return "conflict", code
        job.log("[ERROR] 推送失败")
        return "failed", code

    job = start_job("publish", fn)
    return jsonify({"id": job.id})


@app.get("/api/job/<jid>")
def api_job_get(jid):
    job = JOBS.get(jid)
    if not job:
        raise ApiError("任务不存在", 404)
    offset = int(_arg("offset", 0) or 0)
    return jsonify(job.snapshot(offset))


@app.post("/api/job/<jid>/cancel")
def api_job_cancel(jid):
    job = JOBS.get(jid)
    if not job:
        raise ApiError("任务不存在", 404)
    proc = job.proc
    if proc is not None:
        try:
            proc.terminate()
            threading.Timer(2.0, lambda: _force_kill(proc)).start()
        except Exception:
            pass
    job.state = "canceled"
    return jsonify({"ok": True})


def _force_kill(proc):
    try:
        if proc.poll() is None:
            proc.kill()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 步骤 7 — 实时预览（hugo server 进程管理）
# ---------------------------------------------------------------------------
PREVIEW = {
    "proc": None,
    "url": "http://127.0.0.1:1313/",
    "log": collections.deque(maxlen=400),
    "lock": threading.Lock(),
}


def _preview_reader(proc):
    try:
        for line in proc.stdout:
            PREVIEW["log"].append(line.rstrip("\n"))
    except Exception:
        pass


def _start_preview() -> dict:
    with PREVIEW["lock"]:
        if PREVIEW["proc"] is not None and PREVIEW["proc"].poll() is None:
            return {"running": True, "url": PREVIEW["url"]}
        PREVIEW["log"].clear()
        try:
            proc = subprocess.Popen(
                [
                    "hugo",
                    "server",
                    "-D",
                    "--bind",
                    "127.0.0.1",
                    "--port",
                    "1313",
                    "--disableFastRender",
                    "--navigateToChanged",
                ],
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
                errors="replace",
            )
        except FileNotFoundError:
            PREVIEW["log"].append("[ERROR] hugo 不可用")
            return {"running": False, "url": PREVIEW["url"], "error": "hugo 不可用"}
        PREVIEW["proc"] = proc
        threading.Thread(target=_preview_reader, args=(proc,), daemon=True).start()
        return {"running": True, "url": PREVIEW["url"]}


def _stop_preview() -> dict:
    with PREVIEW["lock"]:
        proc = PREVIEW["proc"]
        if proc is None or proc.poll() is not None:
            PREVIEW["proc"] = None
            return {"running": False, "url": PREVIEW["url"]}
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass

        def _kill():
            try:
                if proc.poll() is None:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass

        threading.Timer(3.0, _kill).start()
        PREVIEW["proc"] = None
        return {"running": False, "url": PREVIEW["url"]}


@app.post("/api/preview/start")
def api_preview_start():
    return jsonify(_start_preview())


@app.get("/api/preview/status")
def api_preview_status():
    proc = PREVIEW["proc"]
    running = proc is not None and proc.poll() is None
    return jsonify(
        {
            "running": running,
            "url": PREVIEW["url"],
            "log": list(PREVIEW["log"])[-50:],
        }
    )


@app.post("/api/preview/stop")
def api_preview_stop():
    return jsonify(_stop_preview())


@atexit.register
def _cleanup():
    try:
        _stop_preview()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def main():
    if not (ROOT / ".git").exists():
        print(f"[ERROR] 不是 git 仓库: {ROOT}", file=sys.stderr)
        sys.exit(2)

    ap = argparse.ArgumentParser(description="myblog 本地控制台")
    ap.add_argument("--port", type=int, default=int(CONFIG.get("port", 8787)))
    ap.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    args = ap.parse_args()

    url = f"http://127.0.0.1:{args.port}"
    print(f"控制台: {url}")
    print(f"仓库根: {ROOT}")
    if not args.no_open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    app.run(host="127.0.0.1", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
