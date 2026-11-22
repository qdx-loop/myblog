"""YAML front matter 解析/生成。

关键约束：date 必须保持字符串，避免 PyYAML 把
'2026-08-06T16:27:43+08:00' 重排成 '2026-08-06 16:27:43+08:00'。
"""

from __future__ import annotations

from datetime import datetime

import yaml

__all__ = ["parse", "emit", "new_meta", "slugify", "KEY_ORDER"]

KEY_ORDER = [
    "title",
    "date",
    "draft",
    "weight",
    "author",
    "tags",
    "categories",
    "description",
]

DEFAULT_AUTHOR = "qdx"


class _Loader(yaml.SafeLoader):
    pass


# 删除 timestamp 隐式解析，保证 date 保持字符串
for _ch, _rs in list(_Loader.yaml_implicit_resolvers.items()):
    _Loader.yaml_implicit_resolvers[_ch] = [
        (t, r) for t, r in _rs if t != "tag:yaml.org,2002:timestamp"
    ]


def parse(text: str) -> tuple[dict, str, bool]:
    """返回 (meta, body, has_fm)。

    无 front matter 时 meta={}, body=原文, has_fm=False。
    空文本返回 ({}, "", False) 而不抛异常。
    """
    if not text:
        return {}, "", False

    lines = text.split("\n")
    if lines[0].strip() != "---":
        return {}, text, False

    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, text, False

    fm_text = "\n".join(lines[1:end])
    body = "\n".join(lines[end + 1 :])
    # 去掉 front matter 结束行后紧跟的一个换行（保留正文其余空白）
    if body.startswith("\n"):
        body = body[1:]

    try:
        meta = yaml.load(fm_text, Loader=_Loader)
    except yaml.YAMLError:
        return {}, text, False
    if not isinstance(meta, dict):
        return {}, text, False
    return meta, body, True


def _ordered(meta: dict) -> dict:
    out: dict = {}
    for k in KEY_ORDER:
        if k in meta:
            out[k] = meta[k]
    for k, v in meta.items():
        if k not in out:
            out[k] = v
    return out


class _Dumper(yaml.SafeDumper):
    pass


def _scalar_list(v) -> bool:
    return isinstance(v, list) and all(
        x is None or isinstance(x, (str, int, float, bool)) for x in v
    )


# tags/categories 这类纯标量列表用行内风格（tags: ["学习", "AI"]），与现有文章一致
_Dumper.add_representer(
    list,
    lambda d, data: d.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=True)
    if _scalar_list(data)
    else d.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=False),
)


def emit(meta: dict, body: str) -> str:
    """生成完整文件文本：front matter + 正文。"""
    dumped = yaml.dump(
        _ordered(meta or {}),
        Dumper=_Dumper,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=4096,
    )
    return "---\n" + dumped + "---\n" + body


def new_meta(
    title: str,
    weight: int,
    tags: list[str],
    categories: list[str],
    description: str,
    draft: bool = False,
) -> dict:
    """新文章 front matter，键序对齐现有文章。"""
    return {
        "title": title,
        "date": datetime.now().astimezone().isoformat(timespec="seconds"),
        "draft": bool(draft),
        "weight": int(weight),
        "author": DEFAULT_AUTHOR,
        "tags": [t for t in (tags or []) if t],
        "categories": [c for c in (categories or []) if c],
        "description": description or "",
    }


def slugify(title: str) -> str:
    """保留中日韩字符、字母数字，其余字符及空白 → '-'，去首尾 '-'。"""
    out: list[str] = []
    prev_dash = False
    for ch in title or "":
        if ch.isalnum() and ("\u4e00" <= ch <= "\u9fff" or ch.isascii()):
            out.append(ch)
            prev_dash = False
        else:
            if not prev_dash and out:
                out.append("-")
                prev_dash = True
    s = "".join(out).strip("-")
    return s
