"""hugo.toml 的“按表定位、只改值”行编辑器 + 校验。

设计目标：保住文件里的注释与排版。做法是绝不整体重生成，
只定位 `[table]` 范围与 `key =` 行，替换 `=` 之后的值字面量，
并保留该行的行尾注释。

已知代价：replace_menu() 会重写所有 [[menu.main]] 块，
菜单块内部的注释会丢失（当前 hugo.toml 的菜单块内无注释）。
"""

from __future__ import annotations

import re
import tomllib

__all__ = [
    "find_table",
    "find_key",
    "set_value",
    "set_array",
    "replace_menu",
    "check",
    "TomlEditError",
]


class TomlEditError(Exception):
    """编辑失败（例如表/键定位不到且无法插入）。"""


_HEADER_RE = re.compile(r"^\s*\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$")


def _split_lines(text: str) -> list[str]:
    return text.split("\n")


def _join(lines: list[str]) -> str:
    return "\n".join(lines)


def _table_header_name(line: str) -> str | None:
    """返回表头的表名；`[[a.b]]` 也返回 'a.b'；非表头行返回 None。"""
    m = _HEADER_RE.match(line)
    if not m:
        return None
    name = m.group(1).strip()
    # 去掉可能的引号段（['a'.b] 这类罕见写法不在支持范围）
    return name


def _is_header(line: str) -> bool:
    return _table_header_name(line) is not None


def find_table(text: str, table: str) -> tuple[int, int] | None:
    """返回 (header_line, end_line_exclusive)。

    table='' 表示根表（首个 [ 或 [[ 之前）；
    'params.waline' 匹配 ^\\[\\s*params\\.waline\\s*\\]\\s*$。
    end = 下一个表头行；缺表返回 None。
    """
    lines = _split_lines(text)

    if table == "":
        end = len(lines)
        for i, ln in enumerate(lines):
            if _is_header(ln):
                end = i
                break
        return 0, end

    pat = re.compile(r"^\s*\[\s*" + re.escape(table) + r"\s*\]\s*(?:#.*)?$")
    for i, ln in enumerate(lines):
        if pat.match(ln):
            end = len(lines)
            for j in range(i + 1, len(lines)):
                if _is_header(lines[j]):
                    end = j
                    break
            return i, end
    return None


def _strip_trailing_comment(s: str) -> tuple[str, str]:
    """把 `值  # 注释` 拆成 (值, '  # 注释')，引号感知。"""
    quote = ""
    i = 0
    while i < len(s):
        ch = s[i]
        if quote:
            if ch == "\\" and quote == '"':
                i += 2
                continue
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch == "#":
            return s[:i].rstrip(), s[i:]
        i += 1
    return s.rstrip(), ""


def _value_span(lines: list[str], start: int) -> int:
    """逻辑值结束行（exclusive）。处理多行数组/内联表：中括号不平衡则续行。"""
    depth = 0
    quote = ""
    for i in range(start, len(lines)):
        s = lines[i]
        j = 0
        while j < len(s):
            ch = s[j]
            if quote:
                if ch == "\\" and quote == '"':
                    j += 2
                    continue
                if ch == quote:
                    quote = ""
            elif ch in "\"'":
                quote = ch
            elif ch == "#" and depth == 0:
                break
            elif ch in "[{":
                depth += 1
            elif ch in "]}":
                depth -= 1
            j += 1
        if depth <= 0 and not quote:
            return i + 1
    return len(lines)


def find_key(text: str, table: str, key: str) -> tuple[int, int] | None:
    """在表范围内匹配 ^\\s*(key|'key'|"key")\\s*=；返回 (line_idx, 值起始列)。"""
    span = find_table(text, table)
    if span is None:
        return None
    lines = _split_lines(text)
    start, end = span
    pat = re.compile(r"^(\s*)(?:'?" + re.escape(key) + r"'?|\"?" + re.escape(key) + r"\"?)\s*=\s*")
    for i in range(start, end):
        m = pat.match(lines[i])
        if m:
            return i, m.end()
    return None


def _quote_str(value: str, prefer_single: bool) -> str:
    if prefer_single and "'" not in value:
        return "'" + value + "'"
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _render_literal(value, prefer_single: bool) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _quote_str(value, prefer_single)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    raise TomlEditError(f"不支持的值类型: {type(value).__name__}")


def _original_prefers_single(original: str) -> bool:
    return original.lstrip().startswith("'")


def set_value(text: str, table: str, key: str, value) -> str:
    """替换该键的值字面量，保留缩进与行尾注释。

    表内无该键 → 在表内最后一个键行后插入；
    表本身不存在 → 文件末尾追加 `[<table>]` 段（嵌套表写全路径）。
    """
    lines = _split_lines(text)
    loc = find_key(text, table, key)

    if loc is not None:
        i, col = loc
        old = lines[i][col:]
        v_end = _value_span(lines, i)
        val_txt, comment = _strip_trailing_comment(old)
        prefer_single = _original_prefers_single(val_txt)
        indent = re.match(r"^\s*", lines[i]).group(0)
        new_line = f"{indent}{key} = {_render_literal(value, prefer_single)}"
        if comment:
            new_line += "  " + comment
        lines[i:v_end] = [new_line]
        return _join(lines)

    span = find_table(text, table)
    literal = _render_literal(value, True)

    if span is None:
        # 追加新表
        out = text.rstrip("\n")
        out += f"\n\n[{table}]\n  {key} = {literal}\n" if out else f"[{table}]\n  {key} = {literal}\n"
        return out

    start, end = span
    # 表内最后一个键行之后插入
    key_re = re.compile(r"^\s*[^#\s\[][^\n]*=")
    insert_at = start + 1
    i = start + 1
    while i < end:
        if key_re.match(lines[i]):
            v_end = _value_span(lines, i)
            insert_at = v_end
            i = v_end
        else:
            i += 1
    # 缩进跟随表内已有键，默认 2 空格
    indent = "  "
    for j in range(start + 1, end):
        m = re.match(r"^(\s+)\S+\s*=", lines[j])
        if m:
            indent = m.group(1)
            break
    lines.insert(insert_at, f"{indent}{key} = {literal}")
    return _join(lines)


def set_array(text: str, table: str, key: str, items: list) -> str:
    """把键设为行内数组字面量，形如 ["a", "b"]。"""
    rendered = []
    for it in items:
        if isinstance(it, str):
            rendered.append(_quote_str(it, False))
        else:
            rendered.append(_render_literal(it, False))
    literal = "[" + ", ".join(rendered) + "]"

    lines = _split_lines(text)
    loc = find_key(text, table, key)
    if loc is not None:
        i, col = loc
        old = lines[i][col:]
        v_end = _value_span(lines, i)
        _, comment = _strip_trailing_comment(old)
        indent = re.match(r"^\s*", lines[i]).group(0)
        new_line = f"{indent}{key} = {literal}"
        if comment:
            new_line += "  " + comment
        lines[i:v_end] = [new_line]
        return _join(lines)
    # 键不存在：借用 set_value 的插入逻辑（先写占位再整行替换字面量太绕，
    # 这里直接复制插入路径）
    span = find_table(text, table)
    if span is None:
        out = text.rstrip("\n")
        out += f"\n\n[{table}]\n  {key} = {literal}\n" if out else f"[{table}]\n  {key} = {literal}\n"
        return out
    start, end = span
    key_re = re.compile(r"^\s*[^#\s\[][^\n]*=")
    insert_at = start + 1
    i = start + 1
    while i < end:
        if key_re.match(lines[i]):
            v_end = _value_span(lines, i)
            insert_at = v_end
            i = v_end
        else:
            i += 1
    indent = "  "
    for j in range(start + 1, end):
        m = re.match(r"^(\s+)\S+\s*=", lines[j])
        if m:
            indent = m.group(1)
            break
    lines.insert(insert_at, f"{indent}{key} = {literal}")
    return _join(lines)


def _normalize_menu(items: list[dict]) -> list[tuple]:
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            w = int(it.get("weight") or 0)
        except (TypeError, ValueError):
            w = 0
        out.append(
            (
                str(it.get("identifier") or ""),
                str(it.get("name") or ""),
                str(it.get("url") or ""),
                w,
            )
        )
    return out


def _detect_menu_quote(text: str) -> bool:
    """菜单块原用单引号则返回 True，否则（含未检测到）返回 False（用双引号）。"""
    lines = _split_lines(text)
    in_menu = False
    for ln in lines:
        name = _table_header_name(ln)
        if name == "menu.main" and ln.strip().startswith("[["):
            in_menu = True
            continue
        if in_menu:
            if _is_header(ln):
                in_menu = False
                continue
            s = ln.lstrip()
            if s.startswith(("identifier", "name", "url")):
                eq = s.find("=")
                if eq >= 0 and s[eq + 1 :].lstrip().startswith("'"):
                    return True
    return False


def replace_menu(text: str, items: list[dict]) -> str:
    """删除所有 [[menu.main]] 块，在文件末尾按 identifier/name/url/weight 重写。

    菜单语义未变时原样返回（不动引号风格、不加空行），避免每次保存都churn。
    菜单块内的注释会丢失（已知代价；当前 hugo.toml 菜单块内无注释）。
    """
    # 幂等：与现有菜单一致则不改动
    try:
        existing = _normalize_menu(tomllib.loads(text).get("menu", {}).get("main", []))
    except Exception:
        existing = None
    new_norm = _normalize_menu(items)
    if existing is not None and existing == new_norm:
        return text

    prefer_single = _detect_menu_quote(text)

    lines = _split_lines(text)
    out: list[str] = []
    i = 0
    while i < len(lines):
        name = _table_header_name(lines[i])
        if name == "menu.main" and lines[i].strip().startswith("[["):
            i += 1
            while i < len(lines) and not _is_header(lines[i]):
                i += 1
            while i < len(lines) and lines[i].strip() == "":
                i += 1
            continue
        out.append(lines[i])
        i += 1

    body = _join(out).rstrip("\n")
    blocks = []
    for ident, name, url, weight in new_norm:
        blocks.append(
            "[[menu.main]]\n"
            f"  identifier = {_quote_str(ident, prefer_single)}\n"
            f"  name = {_quote_str(name, prefer_single)}\n"
            f"  url = {_quote_str(url, prefer_single)}\n"
            f"  weight = {weight}\n"
        )
    sep = "\n" if body else ""
    return body + sep + "\n".join(blocks)


def check(text: str) -> dict:
    """tomllib.loads(text)；失败抛 tomllib.TOMLDecodeError。"""
    return tomllib.loads(text)
