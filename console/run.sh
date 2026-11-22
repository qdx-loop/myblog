#!/usr/bin/env bash
# myblog-console 启动器
# 优先使用系统 python3（本机已装 flask + pyyaml）；缺依赖时自建 .venv 兜底。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8787}"

if python3 -c "import flask, yaml" 2>/dev/null; then
    PY=python3
else
    [ -d .venv ] || python3 -m venv .venv
    .venv/bin/pip install -q --upgrade pip >/dev/null 2>&1 || true
    .venv/bin/pip install -q flask pyyaml
    PY=.venv/bin/python
fi

exec "$PY" app.py --port "$PORT" "$@"
