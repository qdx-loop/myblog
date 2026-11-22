"""git 子进程封装 + 传输回退链（push / fetch / diff / status / log）。

传输实测（2026-11，本机网络）：
  HTTPS   → 匿名读可用，push 需要凭据（无 token 时 `could not read Username`）
  SSH:22  → 被阻断（Connection closed by ... port 22）
  SSH:443 → 可用（ssh.github.com:443）
所以必须保留回退链，顺序不能只依赖某一条。
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

__all__ = [
    "run",
    "transports",
    "push",
    "fetch_test",
    "status_porcelain",
    "log_recent",
    "diff_text",
    "show_commit",
    "restore_file",
    "branch",
    "ahead_behind",
    "build_check",
    "hugo_version",
    "GITHUB_HTTPS",
    "GITHUB_SSH",
    "GITHUB_SSH443",
]

ROOT = Path(os.environ.get("MYBLOG_ROOT", "/home/qdx/myblog")).resolve()
BRANCH_NAME = "master"
SITE_URL = "https://lssx.de5.net/"

GITHUB_HTTPS = "https://github.com/qdx-loop/myblog.git"
GITHUB_SSH = "git@github.com:qdx-loop/myblog.git"
GITHUB_SSH443 = "ssh://git@ssh.github.com:443/qdx-loop/myblog.git"

BASE_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_PAGER": "cat",
    "LC_ALL": "C.UTF-8",
}

CONFLICT_MARKERS = ("non-fast-forward", "fetch first", "rejected", "! [remote rejected]")


def run(
    cmd: list[str], timeout: int = 120, env: dict | None = None, cwd: Path | None = None
) -> tuple[int, str]:
    """subprocess.run 封装，stdout+stderr 合并返回；超时 → rc=124 且输出 'TIMEOUT'。"""
    try:
        p = subprocess.run(
            cmd,
            cwd=str(cwd or ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**BASE_ENV, **(env or {})},
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return 124, "TIMEOUT"
    except FileNotFoundError as e:
        return 127, f"命令不存在: {e}"
    out = (p.stdout or "") + (p.stderr or "")
    return p.returncode, out.rstrip("\n")


def askpass_path() -> Path:
    return Path(os.path.expanduser("~/.config/myblog-console/askpass.sh"))


def ensure_askpass(token: str) -> Path | None:
    """生成 GIT_ASKPASS 脚本（仅当配置了 token）。返回 None 表示不可用。"""
    if not token:
        return None
    p = askpass_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "#!/bin/sh\n"
        'case "$1" in\n'
        "  *Username*) echo x-access-token ;;\n"
        '  *) echo "$MYBLOG_GIT_TOKEN" ;;\n'
        "esac\n",
        encoding="utf-8",
    )
    os.chmod(p, 0o700)
    return p


def transports(token: str | None = None) -> list[dict]:
    """有序传输链，每项 {"name","url","pre":[...],"env":{...}}。"""
    ap = askpass_path() if token else None
    https_env = {}
    if token and ap and ap.exists():
        https_env = {"GIT_ASKPASS": str(ap), "MYBLOG_GIT_TOKEN": token}

    ssh_opts = "ssh -o BatchMode=yes -o ConnectTimeout=10"
    return [
        {
            "name": "HTTPS",
            "url": GITHUB_HTTPS,
            "pre": ["-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=20"],
            "env": https_env,
        },
        {
            "name": "SSH:22",
            "url": GITHUB_SSH,
            # 作为列表 argv 传给 subprocess（无 shell），git 自行按空格切分 sshCommand，
            # 不能用 shlex.quote（会把整串包成单个命令名）。
            "pre": ["-c", f"core.sshCommand={ssh_opts}"],
            "env": {},
        },
        {
            "name": "SSH:443",
            "url": GITHUB_SSH443,
            "pre": [
                "-c",
                "core.sshCommand="
                + ssh_opts
                + " -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR -p 443",
            ],
            "env": {},
        },
    ]


def _push_once(
    t: dict,
    dry_run: bool,
    force: bool,
    on_proc: Callable | None = None,
    timeout: int = 300,
) -> tuple[int, str]:
    cmd = ["git", *t["pre"], "push"]
    if dry_run:
        cmd.append("--dry-run")
    if force:
        cmd.append("-f")
    cmd += [t["url"], BRANCH_NAME]
    if on_proc is not None:
        # 需要可取消：走 Popen，并把进程交给调用方
        p = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env={**BASE_ENV, **t["env"]},
            start_new_session=True,
            errors="replace",
        )
        on_proc(p)
        try:
            out, _ = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            out, _ = p.communicate()
            return 124, (out or "") + "\nTIMEOUT"
        finally:
            on_proc(None)
        return p.returncode, (out or "").rstrip("\n")
    return run(cmd, timeout=timeout, env=t["env"])


def _is_conflict(out: str) -> bool:
    low = out.lower()
    return any(m in low for m in CONFLICT_MARKERS)


def _iter_transports(
    log: Callable[[str], None],
    dry_run: bool,
    force: bool,
    token: str | None,
    on_proc: Callable | None = None,
) -> tuple[bool, int]:
    for t in transports(token):
        log(f"[TRY] {t['name']} → {t['url']}")
        rc, out = _push_once(t, dry_run, force, on_proc)
        if out:
            for line in out.split("\n"):
                log("    " + line)
        if rc == 0:
            log(f"[OK] 推送成功（{t['name']}）")
            return True, 0
        if _is_conflict(out):
            log(f"[CONFLICT] {t['name']} 报告非快进：远端有本地没有的提交")
            return False, 2
        if rc == 124:
            log(f"[WARN] {t['name']} 超时")
        else:
            log(f"[INFO] {t['name']} 失败（rc={rc}），尝试下一条传输")
    return False, 1


def push(
    log: Callable[[str], None],
    dry_run: bool = False,
    force: bool = False,
    token: str | None = None,
    on_proc: Callable | None = None,
) -> tuple[bool, int]:
    """逐项尝试传输链推送 master。

    返回 (ok, code)：code 0=成功，1=全部传输失败，2=非快进冲突（不再尝试后续传输）。
    on_proc(p) 用于把当前 git 子进程交给调用方以支持取消；推送结束后回调 on_proc(None)。
    """
    return _iter_transports(log, dry_run, force, token, on_proc)


def fetch_test(log: Callable[[str], None], token: str | None = None) -> tuple[bool, int]:
    """连通性测试：对每条传输执行 push --dry-run，不改远端。"""
    return _iter_transports(log, True, False, token, None)


def pull_rebase(
    log: Callable[[str], None], token: str | None = None
) -> tuple[bool, int, str]:
    """git pull --rebase <url> master，逐条传输尝试。返回 (ok, rc, out)。"""
    for t in transports(token):
        log(f"[TRY] pull --rebase {t['name']} → {t['url']}")
        rc, out = run(
            ["git", *t["pre"], "pull", "--rebase", t["url"], BRANCH_NAME],
            timeout=300,
            env=t["env"],
        )
        if out:
            for line in out.split("\n"):
                log("    " + line)
        if rc == 0:
            log(f"[OK] 拉取合并成功（{t['name']}）")
            return True, 0, out
        if "could not read" in out.lower() or "permission denied" in out.lower():
            log(f"[INFO] {t['name']} 无法鉴权，尝试下一条传输")
            continue
        log(f"[ERROR] {t['name']} 拉取失败（rc={rc}）")
        return False, rc, out
    return False, 1, ""


def status_porcelain() -> list[dict]:
    rc, out = run(["git", "status", "--porcelain=v1", "--untracked-files=normal"])
    if rc != 0:
        return []
    items = []
    for line in out.split("\n"):
        if len(line) < 4:
            continue
        xy, path = line[:2], line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        items.append({"xy": xy, "path": path})
    return items


def log_recent(limit: int = 20) -> list[dict]:
    rc, out = run(
        [
            "git",
            "log",
            f"-{int(limit)}",
            "--pretty=%h%x1f%ad%x1f%s",
            "--date=iso",
        ]
    )
    if rc != 0:
        return []
    items = []
    for line in out.split("\n"):
        parts = line.split("\x1f")
        if len(parts) == 3:
            items.append({"hash": parts[0], "date": parts[1], "subject": parts[2]})
    return items


def diff_text(path: str | None = None, staged: bool = False) -> str:
    cmd = ["git", "diff", "--staged"] if staged else ["git", "diff"]
    if path:
        cmd += ["--", path]
    rc, out = run(cmd, timeout=60)
    return out if rc == 0 else ""


def show_commit(rev: str) -> str:
    if not rev or len(rev) > 64 or any(c.isspace() for c in rev):
        return ""
    rc, out = run(["git", "show", "--stat", "--patch", rev], timeout=60)
    return out if rc == 0 else f"(无法显示 {rev})"


def restore_file(path: str) -> tuple[int, str]:
    rc, out = run(["git", "restore", "--source=HEAD", "--worktree", "--", path])
    if rc != 0:
        # 未跟踪文件：restore 无从恢复
        rc2, out2 = run(["git", "ls-files", "--error-unmatch", "--", path])
        if rc2 != 0:
            return 1, f"该文件未被 git 跟踪，无法回滚：{path}"
        return rc, out or "git restore 失败"
    return 0, out or f"已回滚 {path}"


def branch() -> str:
    rc, out = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], timeout=20)
    return out.strip() if rc == 0 else "master"


def _count_ref(ref: str) -> dict | None:
    rc, out = run(
        ["git", "rev-list", "--left-right", "--count", f"HEAD...{ref}"], timeout=30
    )
    if rc != 0:
        return None
    parts = out.split()
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        return None
    return {"ahead": int(parts[0]), "behind": int(parts[1])}


def ahead_behind() -> dict:
    for ref in ("origin/master", "github/master", "FETCH_HEAD"):
        got = _count_ref(ref)
        if got is not None:
            got["ref"] = ref
            return got
    return {"ahead": None, "behind": None, "ref": None}


def build_check(log: Callable[[str], None], force: bool = False) -> int:
    """hugo --gc --minify -D 构建到临时目录。返回 0=通过/被忽略，1=失败。"""
    dest = tempfile.mkdtemp(prefix="mbc-hugo-")
    log("[BUILD] hugo --gc --minify -D --destination <tmp>")
    rc, out = run(
        ["hugo", "--gc", "--minify", "-D", "--destination", dest], timeout=180
    )
    if out:
        for line in out.split("\n")[-40:]:
            log("    " + line)
    try:
        subprocess.run(["rm", "-rf", dest], timeout=30, check=False)
    except Exception:
        pass
    if rc == 0:
        log("[OK] 构建校验通过")
        return 0
    if force:
        log("[WARN] 构建失败但被忽略（force_build）")
        return 0
    log(f"[ERROR] 构建校验失败（rc={rc}），已终止发布")
    return 1


def hugo_version() -> str:
    rc, out = run(["hugo", "version"], timeout=20)
    if rc != 0:
        return "(hugo 不可用)"
    return out.split("\n")[0].split(" ", 2)[1] if " " in out else out
