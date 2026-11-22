/* ============================================================
   myblog-console 前端逻辑（原生 ES2020+，无外部依赖）
   分区：工具 / API / Toast / 对话框 / 路由 / 状态条 /
         仪表盘 / 文章 / 设置 / 文件 / 预览 / 发布 / Git
   ============================================================ */
"use strict";

/* ------------------------------------------------------------
   1. 通用工具
   ------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 只允许安全协议的 URL（预览面板与 Markdown 渲染共用） */
function safeUrl(url) {
  const u = String(url || "").trim();
  if (/^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i.test(u)) return u;
  if (/^data:image\//i.test(u)) return u;
  return "#";
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function formatTime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 后端时间串（ISO / "YYYY-MM-DD HH:MM:SS +0800"）→ datetime-local 输入值 */
function toLocalInput(value) {
  if (!value) return "";
  const s = String(value)
    .trim()
    .replace(" ", "T")
    .replace(/ ([+-]\d{2}):?(\d{2})$/, "$1:$2")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** datetime-local 输入值 → 带本地时区偏移的 ISO 串（后端保持字符串原样写入） */
function fromLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (x) => String(Math.abs(x)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(off / 60))}:${p(off % 60)}`
  );
}

/** "AI, 笔记" / "AI，笔记" → ["AI","笔记"] */
function splitList(value) {
  return String(value || "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 在 textarea 光标处插入文本，并保持焦点与光标位置 */
function insertAtCursor(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const pos = start + text.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectLine(ta, lineNo) {
  const lines = ta.value.split("\n");
  let pos = 0;
  for (let i = 0; i < lineNo - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  const len = (lines[lineNo - 1] || "").length;
  ta.focus();
  ta.setSelectionRange(pos, pos + len);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, (lineNo - 4) * lh);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = make("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/* ------------------------------------------------------------
   2. API 封装：任何非 2xx 都抛出带后端 error 文本的异常
   ------------------------------------------------------------ */
class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status || 0;
    this.data = data || {};
  }
  get isConflict() {
    return this.status === 409;
  }
}

async function api(method, url, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError(`无法连接控制台后端：${err.message}`, 0);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 400) };
    }
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(msg, res.status, data || {});
  }
  return data;
}

/** 统一执行 + 错误提示：出错时 toast 后端 error 文本并返回 null */
async function guard(fn, busyEl) {
  if (busyEl) busyEl.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `操作失败：${err.message}`);
    return null;
  } finally {
    if (busyEl) busyEl.disabled = false;
  }
}

/* ------------------------------------------------------------
   3. Toast（右下角堆栈）
   ------------------------------------------------------------ */
const toastBox = () => $("toasts");

function toast(kind, message, ms) {
  const box = toastBox();
  if (!box) return;
  const el = make("div", `toast toast-${kind}`);
  el.appendChild(make("span", "dot"));
  el.appendChild(make("span", "msg", String(message ?? "")));
  const close = make("button", "close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭提示");
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 180);
  };
  close.addEventListener("click", remove);
  el.appendChild(close);
  box.appendChild(el);
  const life = ms ?? (kind === "error" ? 9000 : 4000);
  if (life > 0) setTimeout(remove, life);
  return el;
}

const toastOk = (msg) => toast("ok", msg);
const toastError = (msg) => toast("error", msg);
const toastInfo = (msg) => toast("info", msg);

/* ------------------------------------------------------------
   4. 对话框（基于 <dialog>，返回 Promise）
   ------------------------------------------------------------ */
const dlgEl = () => $("dlg");

/**
 * @param {{title?:string,text?:string,mono?:boolean,okText?:string,cancelText?:string,
 *          danger?:boolean,input?:{label?:string,value?:string,placeholder?:string,multiline?:boolean}}} opts
 * @returns {Promise<{ok:boolean,value:string}>}
 */
function askDialog(opts = {}) {
  return new Promise((resolve) => {
    const dlg = dlgEl();
    if (!dlg) {
      resolve({ ok: !!window.confirm(opts.text || opts.title || ""), value: "" });
      return;
    }
    clearNode(dlg);
    const body = make("div", "dlg-body");
    if (opts.title) body.appendChild(make("div", "dlg-title", opts.title));
    if (opts.text) body.appendChild(make("div", opts.mono ? "dlg-text mono" : "dlg-text", opts.text));

    let input = null;
    if (opts.input) {
      const field = make("div", "dlg-field");
      if (opts.input.label) field.appendChild(make("span", "field-label", opts.input.label));
      input = opts.input.multiline ? make("textarea", "textarea mono") : make("input", "input");
      if (!opts.input.multiline) input.type = "text";
      else input.rows = 6;
      input.value = opts.input.value || "";
      if (opts.input.placeholder) input.placeholder = opts.input.placeholder;
      field.appendChild(input);
      body.appendChild(field);
    }
    dlg.appendChild(body);

    const actions = make("div", "dlg-actions");
    const btnCancel = make("button", "btn btn-ghost", opts.cancelText || "取消");
    const btnOk = make("button", `btn ${opts.danger ? "btn-primary-danger" : "btn-primary"}`, opts.okText || "确定");
    btnCancel.type = "button";
    btnOk.type = "button";
    actions.append(btnCancel, btnOk);
    dlg.appendChild(actions);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close();
      resolve({ ok, value: input ? input.value : "" });
    };
    const onClose = () => finish(false);
    dlg.addEventListener("close", onClose);
    btnCancel.addEventListener("click", () => finish(false));
    btnOk.addEventListener("click", () => finish(true));
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !opts.input.multiline) {
          e.preventDefault();
          finish(true);
        }
      });
    }
    if (!dlg.open) dlg.showModal();
    if (input) {
      input.focus();
      input.select();
    } else {
      btnOk.focus();
    }
  });
}

const confirmDialog = (title, text, opts = {}) =>
  askDialog({ title, text, okText: opts.okText || "确定", cancelText: opts.cancelText || "取消", danger: opts.danger });

/** 409 冲突：文案固定包含外部修改提示，返回 true 表示覆盖 */
async function confirmConflict(extra) {
  const res = await askDialog({
    title: "保存冲突",
    text:
      "文件已被外部修改（可能在 Obsidian 或 Windows 端编辑）。\n\n" +
      "覆盖：用当前编辑内容保存，磁盘上的外部改动会丢失。\n" +
      "放弃：保留磁盘上的版本，本次编辑不保存。" +
      (extra ? `\n\n${extra}` : ""),
    okText: "覆盖",
    cancelText: "放弃",
    danger: true,
  });
  return res.ok;
}

/* ------------------------------------------------------------
   5. 迷你 Markdown 渲染（先 escapeHtml 整体，再逐行变换）
   ------------------------------------------------------------ */
function renderMarkdown(src) {
  const codes = [];
  const inline = (text) => {
    let t = text.replace(/`([^`]+)`/g, (_m, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, url) => {
      return `<img src="${safeUrl(url.replace(/&amp;/g, "&"))}" alt="${alt}">`;
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, url) => {
      return `<a href="${safeUrl(url.replace(/&amp;/g, "&"))}" target="_blank" rel="noopener">${label}</a>`;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return t.replace(/\u0000(\d+)\u0000/g, (_m, n) => `<code>${codes[Number(n)]}</code>`);
  };

  const out = [];
  let listType = null;
  let quoteOpen = false;
  let para = [];
  let inCode = false;
  let codeBuf = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const openList = (type) => {
    if (listType !== type) {
      closeList();
      out.push(`<${type}>`);
      listType = type;
    }
  };
  const closeQuote = () => {
    if (quoteOpen) {
      out.push("</blockquote>");
      quoteOpen = false;
    }
  };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushAll = () => {
    flushPara();
    closeList();
    closeQuote();
  };

  for (const rawLine of escapeHtml(src || "").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");

    if (inCode) {
      if (/^```/.test(line.trim())) {
        out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        codeBuf.push(rawLine);
      }
      continue;
    }
    if (/^```/.test(line.trim())) {
      flushAll();
      inCode = true;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      closeList();
      if (!quoteOpen) {
        out.push("<blockquote>");
        quoteOpen = true;
      }
      out.push(quote[1] ? `<p>${inline(quote[1])}</p>` : "<p></p>");
      continue;
    }
    closeQuote();

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      openList(ul ? "ul" : "ol");
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();

    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line.trim());
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
  flushAll();
  return out.join("\n");
}

/* ------------------------------------------------------------
   6. 路由
   ------------------------------------------------------------ */
const ROUTES = ["dashboard", "posts", "settings", "files", "preview", "publish", "git"];
const STATE = {
  route: "dashboard",
  status: null,
  siteUrl: "",
  preview: { running: false, url: "" },
  settings: null,
  settingsMode: "form",
  settingsFilled: false,
  meta: { tags: [], categories: [], weights: [] },
  posts: [],
  postsLoaded: false,
  currentPost: null,
  postSnapshot: "",
  currentFile: null,
  fileSnapshot: "",
  job: null,
  previewTimer: null,
};

let pendingAction = null;

/** 切到某个路由，切换完成后执行 action（用于仪表盘的快捷按钮） */
function go(route, action) {
  pendingAction = action || null;
  const hash = `#/${route}`;
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

function currentRoute() {
  const m = /^#\/([a-z]+)/.exec(location.hash || "");
  const name = m ? m[1] : "";
  return ROUTES.includes(name) ? name : "dashboard";
}

async function applyRoute() {
  const route = currentRoute();
  STATE.route = route;
  for (const name of ROUTES) {
    const view = $(`view-${name}`);
    if (view) view.classList.toggle("is-active", name === route);
  }
  for (const item of document.querySelectorAll(".nav-item")) {
    if (item.dataset.route === route) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  const action = pendingAction;
  pendingAction = null;
  await guard(refreshStatus);
  await guard(() => loadRoute(route));
  if (action) await guard(action);
}

/** 返回 Promise，调用方负责 await/catch，避免未处理的 rejection */
function loadRoute(route) {
  if (route === "dashboard") return loadDashboard();
  if (route === "posts") return loadPosts();
  if (route === "settings") return loadSettings();
  if (route === "files") return loadFiles();
  if (route === "preview") return loadPreview();
  if (route === "publish") return loadPublish();
  if (route === "git") return loadGit();
  return Promise.resolve();
}

/* ------------------------------------------------------------
   7. 顶部状态条
   ------------------------------------------------------------ */
let statusInFlight = null;

/** 读取仓库状态；并发调用合并为一次请求（各页共享同一份数据） */
function refreshStatus() {
  if (statusInFlight) return statusInFlight;
  statusInFlight = api("GET", "/api/status")
    .then(applyStatus)
    .finally(() => {
      statusInFlight = null;
    });
  return statusInFlight;
}

function applyStatus(st) {
  STATE.status = st;
  STATE.siteUrl = st.site_url || "";
  STATE.preview = st.preview || { running: false, url: "" };

  $("st-branch").textContent = st.branch || "—";
  const dirtyCount = Array.isArray(st.dirty) ? st.dirty.length : 0;
  $("st-dirty").textContent = String(dirtyCount);
  $("st-dirty-chip").classList.toggle("is-warn", dirtyCount > 0);
  $("st-ahead").textContent = st.ahead == null ? "未知" : String(st.ahead);
  $("st-behind").textContent = st.behind == null ? "未知" : String(st.behind);
  $("nav-root").textContent = st.root || "";

  const pv = $("st-preview");
  pv.textContent = STATE.preview.running ? "预览：运行中" : "预览：已停止";
  pv.classList.toggle("btn-primary", !STATE.preview.running);
  pv.title = STATE.preview.running ? "停止 Hugo 预览服务" : "启动 Hugo 预览服务";

  const site = $("st-site");
  if (STATE.siteUrl) {
    site.href = STATE.siteUrl;
    site.hidden = false;
    site.textContent = "打开站点";
  } else {
    site.hidden = true;
  }
  if (STATE.route === "preview") syncPreviewPane();
  return st;
}

async function togglePreviewFromBar() {
  const btn = $("st-preview");
  btn.disabled = true;
  try {
    if (STATE.preview.running) {
      const res = await api("POST", "/api/preview/stop");
      toastOk(`预览已停止${res && res.url ? `：${res.url}` : ""}`);
    } else {
      const res = await api("POST", "/api/preview/start");
      toastOk(`预览已启动：${(res && res.url) || "http://127.0.0.1:1313/"}`);
    }
    await refreshStatus();
    if (STATE.route === "preview") loadPreview();
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `预览操作失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------
   8. 仪表盘
   ------------------------------------------------------------ */
function statCard(label, value, opts = {}) {
  const box = make("div", "stat");
  box.appendChild(make("span", "stat-label", label));
  const v = make("span", `stat-value ${opts.mono ? "mono" : ""} ${opts.muted ? "is-muted" : ""}`.trim());
  v.textContent = value == null || value === "" ? "—" : String(value);
  if (opts.title) v.title = opts.title;
  box.appendChild(v);
  return box;
}

async function loadDashboard() {
  const grid = $("dash-stats");
  clearNode(grid);
  grid.appendChild(statCard("加载中", "…", { muted: true }));

  const st = STATE.status || (await refreshStatus());
  const settings = await api("GET", "/api/settings").catch(() => null);
  if (settings) STATE.settings = settings;

  const form = (settings && settings.form) || {};
  clearNode(grid);
  grid.append(
    statCard("站点标题", form.title || "—", { title: form.baseURL || "" }),
    statCard("站点地址", form.baseURL || st.site_url || "—", { mono: true }),
    statCard("文章 / 草稿", `${st.posts ?? 0} / ${st.drafts ?? 0}`),
    statCard("Hugo 版本", st.hugo || "—", { mono: true }),
    statCard("分支", st.branch || "—", { mono: true }),
    statCard("未提交变更", `${Array.isArray(st.dirty) ? st.dirty.length : 0} 个文件`, {
      muted: !(st.dirty && st.dirty.length),
    }),
    statCard("预览服务", st.preview && st.preview.running ? `运行中 ${st.preview.url}` : "已停止", {
      muted: !(st.preview && st.preview.running),
    }),
    statCard("仓库路径", st.root || "—", { mono: true, muted: true })
  );

  const line = $("dash-commit");
  clearNode(line);
  const lc = st.last_commit;
  if (lc && lc.hash) {
    line.classList.remove("muted");
    line.append(
      make("span", "hash", lc.hash + " "),
      make("span", "", lc.subject || "(无提交信息)"),
      make("span", "date", " · " + (lc.date || ""))
    );
  } else {
    line.classList.add("muted");
    line.textContent = "暂无提交记录";
  }

  $("dash-sub").textContent = `仓库 ${st.root || ""} · 分支 ${st.branch || "—"} · ${st.hugo || ""}`;
}

/* ------------------------------------------------------------
   9. 文章
   ------------------------------------------------------------ */
const POST_KEY_ORDER = ["title", "date", "draft", "weight", "author", "tags", "categories", "description"];

async function loadPosts() {
  if (!STATE.postsLoaded) {
    const [posts, meta] = await Promise.all([
      api("GET", "/api/posts"),
      api("GET", "/api/meta").catch(() => ({ tags: [], categories: [], weights: [] })),
    ]);
    STATE.posts = Array.isArray(posts) ? posts : [];
    STATE.meta = meta || { tags: [], categories: [], weights: [] };
    STATE.postsLoaded = true;
    fillDataList("dl-tags", STATE.meta.tags);
    fillDataList("dl-categories", STATE.meta.categories);
  }
  renderPostList();
}

async function reloadPosts() {
  STATE.postsLoaded = false;
  await loadPosts();
}

function fillDataList(id, values) {
  const dl = $(id);
  if (!dl) return;
  clearNode(dl);
  for (const v of values || []) {
    const opt = make("option");
    opt.value = String(v);
    dl.appendChild(opt);
  }
}

function filteredPosts() {
  const q = $("post-search").value.trim().toLowerCase();
  const draftsOnly = $("post-drafts-only").checked;
  const list = STATE.posts.filter((p) => {
    if (draftsOnly && !p.draft) return false;
    if (!q) return true;
    const hay = [p.title, p.path, (p.tags || []).join(" "), (p.categories || []).join(" ")]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
  list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return list;
}

function renderPostList() {
  const ul = $("post-list");
  clearNode(ul);
  const list = filteredPosts();
  if (!list.length) {
    const li = make("li");
    li.appendChild(make("div", "list-empty", STATE.posts.length ? "没有匹配的文章" : "还没有文章，点击「新建」创建第一篇"));
    ul.appendChild(li);
  }
  for (const p of list) {
    const li = make("li");
    const btn = make("button", "post-item");
    btn.type = "button";
    if (STATE.currentPost && STATE.currentPost.path === p.path) btn.classList.add("is-active");
    btn.appendChild(make("span", "post-title", p.title || p.path.split("/").pop()));
    const meta = make("span", "post-meta");
    meta.appendChild(make("span", "", (p.date || "").slice(0, 10) || "无日期"));
    if (p.draft) meta.appendChild(make("span", "draft", "草稿"));
    const words = Number(p.wordcount) || 0;
    meta.appendChild(make("span", "", `${words} 字`));
    if (p.tags && p.tags.length) meta.appendChild(make("span", "", "# " + p.tags.slice(0, 3).join(" ")));
    btn.appendChild(meta);
    btn.addEventListener("click", () => guard(() => openPost(p.path)));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  $("post-count").textContent = `共 ${STATE.posts.length} 篇，显示 ${list.length} 篇`;
}

async function openPost(path) {
  const data = await api("GET", `/api/post?path=${encodeURIComponent(path)}`);
  STATE.currentPost = data;
  $("post-empty").hidden = true;
  $("post-form").hidden = false;
  $("post-path").textContent = data.path;
  const meta = data.meta || {};
  $("pm-title").value = meta.title ?? "";
  $("pm-date").value = toLocalInput(meta.date);
  $("pm-draft").checked = !!meta.draft;
  $("pm-weight").value = meta.weight === undefined || meta.weight === null ? "" : String(meta.weight);
  $("pm-author").value = meta.author ?? "";
  $("pm-tags").value = Array.isArray(meta.tags) ? meta.tags.join(", ") : String(meta.tags ?? "");
  $("pm-categories").value = Array.isArray(meta.categories)
    ? meta.categories.join(", ")
    : String(meta.categories ?? "");
  $("pm-description").value = meta.description ?? "";
  $("post-body").value = data.body ?? "";
  STATE.postSnapshot = postSnapshot();
  updatePostDirty();
  renderPostPreview();
  renderPostList();
}

function postSnapshot() {
  return [
    $("pm-title").value,
    $("pm-date").value,
    $("pm-draft").checked,
    $("pm-weight").value,
    $("pm-author").value,
    $("pm-tags").value,
    $("pm-categories").value,
    $("pm-description").value,
    $("post-body").value,
  ].join("\u0001");
}

function updatePostDirty() {
  const dirty = !!STATE.currentPost && postSnapshot() !== STATE.postSnapshot;
  $("post-dirty").hidden = !dirty;
  return dirty;
}

function collectPostMeta() {
  const meta = {};
  const title = $("pm-title").value.trim();
  if (title) meta.title = title;
  const date = fromLocalInput($("pm-date").value);
  if (date) meta.date = date;
  meta.draft = $("pm-draft").checked;
  const weightRaw = $("pm-weight").value.trim();
  if (weightRaw !== "") {
    const w = Number(weightRaw);
    if (Number.isFinite(w)) meta.weight = Math.trunc(w);
  }
  const author = $("pm-author").value.trim();
  if (author) meta.author = author;
  meta.tags = splitList($("pm-tags").value);
  meta.categories = splitList($("pm-categories").value);
  const desc = $("pm-description").value.trim();
  if (desc) meta.description = desc;
  const ordered = {};
  for (const key of POST_KEY_ORDER) if (key in meta) ordered[key] = meta[key];
  for (const key of Object.keys(meta)) if (!(key in ordered)) ordered[key] = meta[key];
  return ordered;
}

async function savePost(etagOverride) {
  const post = STATE.currentPost;
  if (!post) {
    toastInfo("请先选择或新建一篇文章");
    return;
  }
  const etag = etagOverride || post.etag;
  let res;
  try {
    res = await api("PUT", "/api/post", {
      path: post.path,
      meta: collectPostMeta(),
      body: $("post-body").value,
      etag,
    });
  } catch (err) {
    if (err instanceof ApiError && err.isConflict) {
      const overwrite = await confirmConflict(`路径：${post.path}`);
      if (overwrite && err.data && err.data.current_etag) {
        await savePost(err.data.current_etag);
      } else if (overwrite) {
        await reloadAndSavePost(post.path);
      }
      return;
    }
    toastError(err instanceof ApiError ? err.message : `保存失败：${err.message}`);
    return;
  }
  post.etag = res && res.etag ? res.etag : post.etag;
  if (res && res.mtime) post.mtime = res.mtime;
  STATE.postSnapshot = postSnapshot();
  updatePostDirty();
  toastOk(`已保存 ${post.path}`);
  const idx = STATE.posts.findIndex((p) => p.path === post.path);
  const fresh = collectPostMeta();
  if (idx >= 0) {
    STATE.posts[idx] = {
      ...STATE.posts[idx],
      title: fresh.title || STATE.posts[idx].title,
      date: fresh.date || STATE.posts[idx].date,
      draft: !!fresh.draft,
      tags: fresh.tags || [],
      categories: fresh.categories || [],
      mtime: res && res.mtime ? res.mtime : STATE.posts[idx].mtime,
    };
  }
  renderPostList();
}

/** 冲突后没有 current_etag 时的兜底：重读 etag 再保存一次 */
async function reloadAndSavePost(path) {
  const fresh = await api("GET", `/api/post?path=${encodeURIComponent(path)}`);
  STATE.currentPost.etag = fresh.etag;
  await savePost(fresh.etag);
}

function renderPostPreview() {
  const box = $("post-preview");
  const html = renderMarkdown($("post-body").value);
  box.innerHTML = html || '<p class="md-empty">（正文为空，预览暂无内容）</p>';
}

async function newPostDialog() {
  const res = await askDialog({
    title: "新建文章",
    text: "文件名由标题自动生成，放在 content/posts/ 下。",
    input: { label: "标题", value: "", placeholder: "例如：控制台使用记录" },
    okText: "创建",
  });
  if (!res.ok) return;
  const title = res.value.trim();
  if (!title) {
    toastError("标题不能为空");
    return;
  }
  const created = await api("POST", "/api/post/new", {
    title,
    tags: [],
    categories: [],
    description: "",
    draft: false,
    filename: "",
  });
  toastOk(`已创建 ${created.path}`);
  await reloadPosts();
  await openPost(created.path);
  $("pm-title").focus();
}

async function deleteCurrentPost() {
  const post = STATE.currentPost;
  if (!post) {
    toastInfo("请先选择一篇文章");
    return;
  }
  const res = await confirmDialog(
    "删除文章",
    `确定删除 ${post.path} 吗？\n文件会移入回收站，不会永久删除。`,
    { okText: "删除", danger: true }
  );
  if (!res.ok) return;
  const out = await api("POST", "/api/file/delete", { path: post.path });
  toastOk(`已移入回收站：${(out && out.trashed) || post.path}`);
  STATE.currentPost = null;
  $("post-form").hidden = true;
  $("post-empty").hidden = false;
  $("post-path").textContent = "未选择文章";
  $("post-dirty").hidden = true;
  await reloadPosts();
}

/**
 * 上传文件到 /api/upload。
 * @param {FileList|File[]} files
 * @param {HTMLTextAreaElement} [ta] 传入则把返回的 markdown 插到光标处（仅图片）
 */
async function uploadFiles(files, ta) {
  let list = Array.from(files || []);
  if (ta) {
    list = list.filter(
      (f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(f.name)
    );
    if (!list.length) {
      toastError("请选择图片文件");
      return;
    }
  }
  if (!list.length) return;

  for (const file of list) {
    const fd = new FormData();
    fd.append("file", file);
    let res;
    try {
      res = await api("POST", "/api/upload", fd);
    } catch (err) {
      toastError(`${file.name} 上传失败：${err instanceof ApiError ? err.message : err.message}`);
      continue;
    }
    if (ta && res && res.markdown) insertAtCursor(ta, `${res.markdown}\n`);
    toastOk(`已上传 ${res && res.path ? res.path : file.name}`);
  }
  if (ta) renderPostPreview();
  if (STATE.route === "files" && $("file-tree").childElementCount) await loadFiles(true);
}

async function copyCurrentPath() {
  const post = STATE.currentPost;
  if (!post) {
    toastInfo("请先选择一篇文章");
    return;
  }
  const ok = await copyText(post.path);
  if (ok) toastOk(`已复制路径：${post.path}`);
  else toastError("复制失败，请手动选择路径文本");
}

/* ------------------------------------------------------------
   10. 设置
   ------------------------------------------------------------ */
const SET_GROUPS = [
  {
    title: "站点",
    fields: [
      { key: "title", label: "站点标题", type: "text" },
      { key: "baseURL", label: "站点地址", type: "text", mono: true },
      { key: "locale", label: "语言", type: "text", mono: true },
      { key: "theme", label: "主题", type: "text", mono: true },
    ],
  },
  {
    title: "显示",
    fields: [
      { key: "author", label: "作者", type: "text" },
      { key: "defaultTheme", label: "默认主题", type: "select", options: ["dark", "light", "auto"] },
      { key: "dateFormat", label: "日期格式", type: "text", mono: true },
      { key: "ShowReadingTime", label: "显示阅读时长", type: "bool" },
      { key: "ShowShareButtons", label: "显示分享按钮", type: "bool" },
      { key: "ShowPostNavLinks", label: "文章间导航", type: "bool" },
      { key: "ShowBreadCrumbs", label: "显示面包屑", type: "bool" },
      { key: "comments", label: "开启评论", type: "bool" },
      { key: "enableSearch", label: "启用搜索（params）", type: "bool" },
    ],
  },
  {
    title: "首页",
    fields: [
      { key: "homeTitle", label: "首页标题", type: "text" },
      { key: "homeContent", label: "首页正文", type: "textarea" },
    ],
  },
  {
    title: "搜索",
    fields: [
      { key: "searchEnable", label: "启用搜索", type: "bool" },
      { key: "searchLimit", label: "结果条数", type: "number", step: "1" },
      { key: "fuseKeys", label: "匹配字段", type: "list", hint: "逗号分隔" },
      { key: "fuseThreshold", label: "阈值 threshold", type: "number", step: "0.05" },
      { key: "fuseLocation", label: "位置 location", type: "number", step: "1" },
      { key: "fuseDistance", label: "距离 distance", type: "number", step: "1" },
    ],
  },
  {
    title: "评论 Waline",
    fields: [
      { key: "walineEnable", label: "启用 Waline", type: "bool" },
      { key: "walineServer", label: "服务地址", type: "text", mono: true },
      { key: "walinePlaceholder", label: "输入框提示", type: "text" },
      { key: "walineLogin", label: "登录方式", type: "select", options: ["enable", "disable", "force"] },
      { key: "walineRequiredMeta", label: "必填项", type: "list", hint: "如 nick, mail" },
      { key: "walineWordLimit", label: "字数限制", type: "number", step: "1" },
      { key: "walinePageSize", label: "每页条数", type: "number", step: "1" },
      { key: "walineUpload", label: "允许上传图片", type: "bool" },
      { key: "walineEmoji", label: "允许表情", type: "bool" },
    ],
  },
];

const setInputs = new Map();

function buildSettingField(field) {
  const row = make("div", `set-row ${field.type === "bool" ? "is-switch" : ""}`);
  const label = make("div", "row-label");
  label.appendChild(make("span", "", field.label));
  label.appendChild(make("small", "", field.key));
  row.appendChild(label);

  const control = make("div", "control");
  let input;
  if (field.type === "bool") {
    const check = make("label", "check");
    input = make("input");
    input.type = "checkbox";
    check.append(input, make("span", "", field.hint || "启用"));
    control.appendChild(check);
  } else if (field.type === "select") {
    input = make("select");
    for (const opt of field.options) {
      const o = make("option", "", opt);
      o.value = opt;
      input.appendChild(o);
    }
    control.appendChild(input);
  } else if (field.type === "textarea") {
    input = make("textarea", "textarea textarea-sm");
    input.rows = 3;
    control.appendChild(input);
  } else {
    input = make("input", field.mono ? "input mono" : "input");
    input.type = field.type === "number" ? "number" : "text";
    if (field.step) input.step = field.step;
    if (field.type === "number") input.style.maxWidth = "160px";
    control.appendChild(input);
    if (field.hint) control.appendChild(make("span", "muted", field.hint));
  }
  input.dataset.key = field.key;
  input.dataset.type = field.type;
  setInputs.set(field.key, input);
  row.appendChild(control);
  return row;
}

function buildSettingsForm() {
  const wrap = $("set-groups");
  if (wrap.childElementCount) return;
  for (const group of SET_GROUPS) {
    const panel = make("div", "panel set-group");
    const head = make("h2");
    head.append(make("span", "", group.title));
    panel.appendChild(head);
    const rows = make("div", "set-rows");
    for (const field of group.fields) rows.appendChild(buildSettingField(field));
    panel.appendChild(rows);
    wrap.appendChild(panel);
  }
}

function fillSettingsForm(data) {
  const form = (data && data.form) || {};
  for (const [key, input] of setInputs) {
    const value = form[key];
    const type = input.dataset.type;
    if (type === "bool") input.checked = !!value;
    else if (type === "list") input.value = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    else if (type === "number") input.value = value === undefined || value === null ? "" : String(value);
    else input.value = value === undefined || value === null ? "" : String(value);
  }
  renderMenuRows((data && data.menu) || []);
  renderReadonly((data && data.readonly) || {});
  const raw = $("set-raw");
  raw.value = (data && data.raw) || "";
}

function collectSettingsForm() {
  const values = {};
  for (const [key, input] of setInputs) {
    const type = input.dataset.type;
    if (type === "bool") values[key] = input.checked;
    else if (type === "list") values[key] = splitList(input.value);
    else if (type === "number") {
      const raw = input.value.trim();
      values[key] = raw === "" ? 0 : Number(raw);
    } else values[key] = input.value;
  }
  return values;
}

function renderMenuRows(menu) {
  const tbody = $("set-menu");
  clearNode(tbody);
  const items = Array.isArray(menu) && menu.length ? menu : [];
  for (const item of items) tbody.appendChild(menuRow(item));
  if (!items.length) {
    const tr = make("tr");
    const td = make("td", "table-empty", "暂无菜单项，点击「添加行」创建");
    td.colSpan = 5;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function menuRow(item = {}) {
  const tr = make("tr");
  for (const key of ["identifier", "name", "url"]) {
    const td = make("td");
    const input = make("input", key === "url" ? "input mono" : "input");
    input.type = "text";
    input.value = item[key] === undefined || item[key] === null ? "" : String(item[key]);
    input.dataset.menuKey = key;
    td.appendChild(input);
    tr.appendChild(td);
  }
  const tdW = make("td");
  const w = make("input", "input mono menu-weight");
  w.type = "number";
  w.step = "1";
  w.value = item.weight === undefined || item.weight === null ? "" : String(item.weight);
  w.dataset.menuKey = "weight";
  tdW.appendChild(w);
  tr.appendChild(tdW);

  const tdAct = make("td", "col-act");
  const del = make("button", "btn btn-sm btn-danger", "删除");
  del.type = "button";
  del.addEventListener("click", () => {
    tr.remove();
    if (!$("set-menu").querySelector("tr[data-row]")) renderMenuRows([]);
  });
  tdAct.appendChild(del);
  tr.appendChild(tdAct);
  tr.dataset.row = "1";
  return tr;
}

function collectMenu() {
  const rows = [];
  for (const tr of $("set-menu").querySelectorAll("tr[data-row]")) {
    const item = {};
    for (const input of tr.querySelectorAll("input")) {
      const key = input.dataset.menuKey;
      if (key === "weight") {
        const n = Number(input.value);
        item.weight = input.value.trim() === "" || !Number.isFinite(n) ? 0 : Math.trunc(n);
      } else {
        item[key] = input.value.trim();
      }
    }
    if (item.identifier || item.name || item.url) rows.push(item);
  }
  return rows;
}

function renderReadonly(readonly) {
  const box = $("set-readonly");
  clearNode(box);
  const entries = Object.entries(readonly || {});
  if (!entries.length) {
    box.textContent = "（后端未返回只读配置）";
    return;
  }
  for (const [key, value] of entries) {
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    box.appendChild(make("div", "", `${key} = [${text}]`));
  }
}

function setSettingsMode(mode) {
  const formMode = mode === "form";
  $("set-form-wrap").hidden = !formMode;
  $("set-raw-wrap").hidden = formMode;
  $("set-mode-form").classList.toggle("is-active", formMode);
  $("set-mode-raw").classList.toggle("is-active", !formMode);
  $("set-mode-form").setAttribute("aria-pressed", String(formMode));
  $("set-mode-raw").setAttribute("aria-pressed", String(!formMode));
  STATE.settingsMode = mode;
}

async function loadSettings(force) {
  buildSettingsForm();
  if (force || !STATE.settingsFilled) {
    const data = await api("GET", "/api/settings");
    STATE.settings = data;
    fillSettingsForm(data);
    STATE.settingsFilled = true;
  } else if (!$("set-raw").value.trim() && STATE.settings) {
    // 已填过表单：切回来时只补原文，避免覆盖未保存的编辑
    $("set-raw").value = STATE.settings.raw || "";
  }
  $("set-status").textContent = "";
  loadBackups().catch((err) => toastError(err.message));
}

async function loadBackups() {
  const list = await api("GET", "/api/settings/backups");
  const tbody = $("set-backups");
  clearNode(tbody);
  const items = Array.isArray(list) ? list : [];
  if (!items.length) {
    const tr = make("tr");
    const td = make("td", "table-empty", "还没有备份，保存设置后会自动生成");
    td.colSpan = 4;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  items.sort((a, b) => String(b.name).localeCompare(String(a.name)));
  for (const item of items) {
    const tr = make("tr");
    tr.appendChild(make("td", "mono", item.name));
    tr.appendChild(make("td", "col-num num", formatSize(item.size)));
    tr.appendChild(make("td", "muted", formatTime(item.mtime)));
    const td = make("td", "col-act");
    const btn = make("button", "btn btn-sm", "恢复");
    btn.type = "button";
    btn.addEventListener("click", () => guard(() => restoreBackup(item.name), btn));
    td.appendChild(btn);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function restoreBackup(name) {
  const res = await confirmDialog(
    "恢复备份",
    `确定用备份 ${name} 覆盖当前 hugo.toml 吗？\n当前文件会先自动备份。`,
    { okText: "恢复", danger: true }
  );
  if (!res.ok) return;
  const out = await api("POST", "/api/settings/restore", { name });
  toastOk(`已恢复 ${name}`);
  const data = await api("GET", "/api/settings");
  STATE.settings = data;
  fillSettingsForm(data);
  if (out && out.raw) $("set-raw").value = out.raw;
  loadBackups().catch(() => {});
}

async function saveSettings() {
  const mode = STATE.settingsMode === "raw" ? "raw" : "form";
  const payload =
    mode === "raw"
      ? { mode: "raw", raw: $("set-raw").value }
      : { mode: "form", values: collectSettingsForm(), menu: collectMenu() };
  const btn = $("set-save");
  btn.disabled = true;
  $("set-status").textContent = "保存中…";
  try {
    const res = await api("PUT", "/api/settings", payload);
    $("set-status").textContent = `已保存 ${new Date().toLocaleTimeString("zh-CN")}`;
    toastOk(mode === "raw" ? "设置已保存（原文模式）" : "设置已保存");
    if (res && res.raw) {
      const data = await api("GET", "/api/settings");
      STATE.settings = data;
      fillSettingsForm(data);
    }
    loadBackups().catch(() => {});
  } catch (err) {
    $("set-status").textContent = "";
    toastError(err instanceof ApiError ? err.message : `保存失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function checkRawToml() {
  const raw = $("set-raw").value;
  const btn = $("set-check");
  btn.disabled = true;
  try {
    const res = await api("POST", "/api/hugo/check", { raw });
    if (res && res.ok) toastOk("TOML 校验通过");
    else toastError((res && res.error) || "TOML 校验失败");
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `校验失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------
   11. 文件管理
   ------------------------------------------------------------ */
const treeLoaded = new Set();
let treeInFlight = false;

async function loadFiles(force) {
  const tree = $("file-tree");
  if (force) {
    treeLoaded.clear();
    clearNode(tree);
  }
  if (tree.childElementCount || treeInFlight) return;
  treeInFlight = true;
  const note = make("div", "tree-note", "加载中…");
  tree.appendChild(note);
  try {
    await loadDir("", tree, 0);
  } finally {
    note.remove();
    treeInFlight = false;
  }
}

async function loadDir(dir, container, depth) {
  const data = await api("GET", `/api/tree?dir=${encodeURIComponent(dir)}&depth=1`);
  treeLoaded.add(dir);
  const entries = (data && data.entries) || [];
  if (!entries.length) {
    container.appendChild(make("div", "tree-note", "（空目录）"));
    return;
  }
  for (const entry of entries) container.appendChild(treeRow(entry, depth));
}

function treeRow(entry, depth) {
  const node = make("div", "tree-node");
  const row = make("button", `tree-row ${entry.is_dir ? "is-dir" : ""}`);
  row.type = "button";
  row.title = entry.path;
  row.appendChild(make("span", "tw", entry.is_dir ? "▸" : ""));
  row.appendChild(make("span", "nm", entry.name));
  if (!entry.is_dir) row.appendChild(make("span", "sz", formatSize(entry.size)));
  node.appendChild(row);

  if (entry.is_dir) {
    const children = make("div", "tree-children");
    children.hidden = true;
    node.appendChild(children);
    row.addEventListener("click", async () => {
      const opening = children.hidden;
      children.hidden = !opening;
      row.querySelector(".tw").textContent = opening ? "▾" : "▸";
      if (opening && !treeLoaded.has(entry.path)) {
        children.appendChild(make("div", "tree-note", "加载中…"));
        try {
          clearNode(children);
          await loadDir(entry.path, children, depth + 1);
        } catch (err) {
          clearNode(children);
          children.appendChild(make("div", "tree-note", `加载失败：${err.message}`));
          toastError(err instanceof ApiError ? err.message : err.message);
        }
      }
    });
  } else {
    row.addEventListener("click", () => guard(() => openFile(entry.path)));
  }
  return node;
}

function markActiveTreeRow(path) {
  for (const row of document.querySelectorAll(".tree-row")) {
    row.classList.toggle("is-active", row.title === path);
  }
}

async function openFile(path, hit) {
  const data = await api("GET", `/api/file?path=${encodeURIComponent(path)}`);
  STATE.currentFile = data;
  $("file-empty").hidden = true;
  $("file-path").textContent = data.path;
  markActiveTreeRow(path);

  const body = $("file-editor-body");
  const ta = $("file-content");
  const binaryBox = $("file-binary");

  if (data.binary) {
    ta.hidden = true;
    body.classList.remove("is-code");
    binaryBox.hidden = false;
    const link = $("file-binary-link");
    link.href = `/api/file/download?path=${encodeURIComponent(data.path)}`;
    link.textContent = `下载 ${data.path}（${formatSize(data.size)}）`;
    $("file-dirty").hidden = true;
    $("file-hit").hidden = true;
    return;
  }

  binaryBox.hidden = true;
  ta.hidden = false;
  body.classList.add("is-code");
  ta.value = data.content || "";
  STATE.fileSnapshot = ta.value;
  updateFileDirty();

  const banner = $("file-hit");
  if (hit && hit.line) {
    clearNode(banner);
    banner.hidden = false;
    const label = make("span", "", `搜索命中：第 ${hit.line} 行`);
    const text = make("span", "mono");
    const full = String(hit.text || "");
    const idx = full.toLowerCase().indexOf(String(hit.q || "").toLowerCase());
    if (idx >= 0 && hit.q) {
      text.append(
        document.createTextNode(full.slice(0, idx)),
        make("mark", "hl", full.slice(idx, idx + hit.q.length)),
        document.createTextNode(full.slice(idx + hit.q.length))
      );
    } else {
      text.textContent = full;
    }
    label.append(document.createTextNode(" "));
    banner.append(label, text);
    selectLine(ta, Number(hit.line));
  } else {
    banner.hidden = true;
  }
}

function updateFileDirty() {
  const ta = $("file-content");
  const dirty = !!STATE.currentFile && !STATE.currentFile.binary && ta.value !== STATE.fileSnapshot;
  $("file-dirty").hidden = !dirty;
  return dirty;
}

async function saveFile(etagOverride) {
  const file = STATE.currentFile;
  if (!file) {
    toastInfo("请先选择一个文件");
    return;
  }
  if (file.binary) {
    toastInfo("二进制文件不可编辑");
    return;
  }
  const etag = etagOverride || file.etag;
  let res;
  try {
    res = await api("PUT", "/api/file", { path: file.path, content: $("file-content").value, etag });
  } catch (err) {
    if (err instanceof ApiError && err.isConflict) {
      const overwrite = await confirmConflict(`路径：${file.path}`);
      if (overwrite) {
        if (err.data && err.data.current_etag) await saveFile(err.data.current_etag);
        else {
          const fresh = await api("GET", `/api/file?path=${encodeURIComponent(file.path)}`);
          await saveFile(fresh.etag);
        }
      }
      return;
    }
    toastError(err instanceof ApiError ? err.message : `保存失败：${err.message}`);
    return;
  }
  file.etag = res && res.etag ? res.etag : file.etag;
  STATE.fileSnapshot = $("file-content").value;
  updateFileDirty();
  toastOk(`已保存 ${file.path}`);
}

async function newFileDialog() {
  const res = await askDialog({
    title: "新建文件",
    text: "填写仓库相对路径，父目录会自动创建。",
    input: { label: "路径", value: "content/posts/", placeholder: "content/posts/新文章.md" },
    okText: "创建",
  });
  if (!res.ok) return;
  const path = res.value.trim().replace(/^\/+/, "");
  if (!path || path.endsWith("/")) {
    toastError("请填写完整的文件路径");
    return;
  }
  try {
    await api("POST", "/api/file/new", { path, content: "" });
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `创建失败：${err.message}`);
    return;
  }
  toastOk(`已创建 ${path}`);
  await loadFiles(true);
  await openFile(path);
}

async function renameFileDialog() {
  const file = STATE.currentFile;
  if (!file) {
    toastInfo("请先选择一个文件");
    return;
  }
  const res = await askDialog({
    title: "重命名 / 移动",
    text: `当前路径：${file.path}`,
    input: { label: "新路径", value: file.path },
    okText: "重命名",
  });
  if (!res.ok) return;
  const to = res.value.trim().replace(/^\/+/, "");
  if (!to || to === file.path) return;
  try {
    await api("POST", "/api/file/rename", { from: file.path, to });
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `重命名失败：${err.message}`);
    return;
  }
  toastOk(`已重命名为 ${to}`);
  STATE.currentFile = null;
  await loadFiles(true);
  await openFile(to);
}

async function deleteFileDialog() {
  const file = STATE.currentFile;
  if (!file) {
    toastInfo("请先选择一个文件");
    return;
  }
  const res = await confirmDialog("删除文件", `确定删除 ${file.path} 吗？\n文件会移入回收站，不会永久删除。`, {
    okText: "删除",
    danger: true,
  });
  if (!res.ok) return;
  try {
    const out = await api("POST", "/api/file/delete", { path: file.path });
    toastOk(`已移入回收站：${(out && out.trashed) || file.path}`);
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `删除失败：${err.message}`);
    return;
  }
  STATE.currentFile = null;
  $("file-content").hidden = true;
  $("file-binary").hidden = true;
  $("file-empty").hidden = false;
  $("file-editor-body").classList.remove("is-code");
  $("file-path").textContent = "未选择文件";
  $("file-dirty").hidden = true;
  $("file-hit").hidden = true;
  await loadFiles(true);
}

function downloadCurrentFile() {
  const file = STATE.currentFile;
  if (!file) {
    toastInfo("请先选择一个文件");
    return;
  }
  const a = make("a");
  a.href = `/api/file/download?path=${encodeURIComponent(file.path)}`;
  a.download = file.path.split("/").pop();
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function runSearch() {
  const q = $("file-search").value.trim();
  if (!q) {
    toastInfo("请输入要搜索的文本");
    return;
  }
  const list = $("file-results-list");
  clearNode(list);
  $("file-results-count").textContent = "搜索中…";
  $("file-tree").hidden = true;
  $("file-results").hidden = false;
  let data;
  try {
    data = await api("GET", `/api/search?q=${encodeURIComponent(q)}&limit=50`);
  } catch (err) {
    $("file-results-count").textContent = "";
    toastError(err instanceof ApiError ? err.message : `搜索失败：${err.message}`);
    return;
  }
  const hits = (data && data.hits) || [];
  $("file-results-count").textContent = `命中 ${hits.length} 处${hits.length >= 50 ? "（仅显示前 50）" : ""}`;
  if (!hits.length) {
    const li = make("li");
    li.appendChild(make("div", "list-empty", `没有找到包含「${q}」的文本`));
    list.appendChild(li);
    return;
  }
  for (const hit of hits) {
    const li = make("li");
    const btn = make("button", "result-item");
    btn.type = "button";
    btn.appendChild(make("span", "result-path", `${hit.path}:${hit.line}`));
    const text = String(hit.text || "").trim();
    const lower = text.toLowerCase();
    const idx = q ? lower.indexOf(q.toLowerCase()) : -1;
    const line = make("span", "result-text");
    if (idx >= 0) {
      line.append(
        document.createTextNode(text.slice(0, idx)),
        make("mark", "hl", text.slice(idx, idx + q.length)),
        document.createTextNode(text.slice(idx + q.length))
      );
    } else {
      line.textContent = text;
    }
    btn.appendChild(line);
    btn.addEventListener("click", () => guard(() => openFile(hit.path, { line: hit.line, text, q })));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function closeSearchResults() {
  $("file-results").hidden = true;
  $("file-tree").hidden = false;
}

/* ------------------------------------------------------------
   12. 预览
   ------------------------------------------------------------ */
/* hugo server 在 running=true 后约 1 秒才真正绑端口；过早给 iframe 设 src
   会留下 chrome-error 页，且 dataset.src 守卫会阻止重设。先用 no-cors fetch
   探测端口可达，再设 src；轮询会在下一拍重试直到成功。 */
async function setPreviewFrame(url) {
  const frame = $("pv-frame");
  if (frame.dataset.src === url) return;
  let ok = false;
  try {
    await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store" });
    ok = true;
  } catch (err) {
    ok = false;
  }
  if (!ok) return;
  frame.src = url;
  frame.dataset.src = url;
}

function syncPreviewPane() {
  const pv = STATE.preview || {};
  const status = $("pv-status");
  status.textContent = pv.running ? `运行中 · ${pv.url || "http://127.0.0.1:1313/"}` : "已停止";
  status.classList.toggle("muted", !pv.running);
  $("pv-start").disabled = !!pv.running;
  $("pv-stop").disabled = !pv.running;
  const open = $("pv-open");
  const frame = $("pv-frame");
  const hint = $("pv-frame-hint");
  if (pv.running && pv.url) {
    open.href = pv.url;
    open.hidden = false;
    setPreviewFrame(pv.url);
    hint.hidden = true;
  } else {
    open.hidden = true;
    if (frame.dataset.src) {
      frame.src = "about:blank";
      frame.dataset.src = "";
    }
    hint.hidden = false;
  }
}

async function loadPreview() {
  let st;
  try {
    st = await api("GET", "/api/preview/status");
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `读取预览状态失败：${err.message}`);
    return;
  }
  STATE.preview = { running: !!st.running, url: st.url || "" };
  if (STATE.status) STATE.status.preview = STATE.preview;
  renderPreviewLog(st.log || []);
  syncPreviewPane();
  startPreviewPolling();
}

function renderPreviewLog(lines) {
  const pre = $("pv-log");
  clearNode(pre);
  if (!lines.length) {
    pre.textContent = "（暂无日志）";
    return;
  }
  pre.textContent = lines.join("\n");
  pre.scrollTop = pre.scrollHeight;
}

function startPreviewPolling() {
  stopPreviewPolling();
  STATE.previewTimer = setInterval(() => {
    if (STATE.route !== "preview") {
      stopPreviewPolling();
      return;
    }
    api("GET", "/api/preview/status")
      .then((st) => {
        const wasRunning = STATE.preview.running;
        STATE.preview = { running: !!st.running, url: st.url || "" };
        renderPreviewLog(st.log || []);
        syncPreviewPane();
        if (wasRunning && !st.running) {
          const btn = $("st-preview");
          btn.textContent = "预览：已停止";
          btn.classList.add("btn-primary");
        }
      })
      .catch(() => {});
  }, 2000);
}

function stopPreviewPolling() {
  if (STATE.previewTimer) {
    clearInterval(STATE.previewTimer);
    STATE.previewTimer = null;
  }
}

async function startPreview() {
  const btn = $("pv-start");
  btn.disabled = true;
  try {
    const res = await api("POST", "/api/preview/start");
    STATE.preview = { running: !!res.running, url: res.url || "" };
    toastOk(`预览已启动：${STATE.preview.url}`);
    await loadPreview();
    refreshStatus().catch(() => {});
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `启动失败：${err.message}`);
    btn.disabled = false;
  }
}

async function stopPreview() {
  const btn = $("pv-stop");
  btn.disabled = true;
  try {
    const res = await api("POST", "/api/preview/stop");
    STATE.preview = { running: !!res.running, url: res.url || STATE.preview.url };
    toastOk("预览已停止");
    await loadPreview();
    refreshStatus().catch(() => {});
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `停止失败：${err.message}`);
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------
   13. 发布 / 任务轮询
   ------------------------------------------------------------ */
const JOB_STATE_TEXT = {
  running: "运行中",
  done: "完成",
  failed: "失败",
  conflict: "冲突",
  canceled: "已取消",
};
const JOB_STATE_CLASS = {
  running: "badge badge-info",
  done: "badge badge-ok",
  failed: "badge badge-danger",
  conflict: "badge badge-warn",
  canceled: "badge",
};

function logLineClass(line) {
  const m = /^\[([A-Z]+)\]/.exec(line);
  if (!m) return "l-dim";
  switch (m[1]) {
    case "STATUS":
      return "l-status";
    case "OK":
      return "l-ok";
    case "URL":
      return "l-url";
    case "WARN":
      return "l-warn";
    case "ERROR":
    case "HINT":
      return "l-err";
    case "INFO":
      return "l-info";
    default:
      return "l-dim";
  }
}

function appendLog(pre, lines) {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  for (const line of lines) {
    const span = make("span", logLineClass(line));
    span.textContent = line + "\n";
    pre.appendChild(span);
  }
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function setJobState(state, rc) {
  const badge = $("pub-state");
  badge.className = JOB_STATE_CLASS[state] || "badge";
  badge.textContent = state === "running" ? "运行中" : `${JOB_STATE_TEXT[state] || state}${rc === undefined || rc === null ? "" : ` · rc=${rc}`}`;
}

function publishOptions(mode) {
  const scope = document.querySelector('input[name="pub-scope"]:checked');
  return {
    message: $("pub-message").value.trim() || "Update",
    scope: scope ? scope.value : "posts",
    skip_build: $("pub-skip-build").checked,
    force_build: $("pub-force-build").checked,
    include_submodule: $("pub-submodule").checked,
    dry_run: $("pub-dry-run").checked,
    mode: mode || "normal",
  };
}

async function startPublishJob(kind, mode) {
  if (STATE.job && STATE.job.running) {
    toastInfo("已有任务在运行，请先取消或等待结束");
    return;
  }
  const pre = $("pub-log");
  clearNode(pre);
  $("pub-done").hidden = true;
  $("pub-hint").hidden = true;
  setJobState("running");
  $("pub-cancel").hidden = false;

  let res;
  try {
    res =
      kind === "test-remote"
        ? await api("POST", "/api/job/test-remote")
        : await api("POST", "/api/job/publish", publishOptions(mode));
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `启动任务失败：${err.message}`);
    setJobState("failed", null);
    $("pub-cancel").hidden = true;
    return;
  }
  const jobId = res && res.id;
  if (!jobId) {
    toastError("后端未返回任务 ID");
    setJobState("failed", null);
    $("pub-cancel").hidden = true;
    return;
  }
  STATE.job = { id: jobId, running: true };
  appendLog(pre, [`[STATUS] 任务已启动（${kind}${mode ? " / " + mode : ""}）id=${jobId}`]);

  let offset = 0;
  let final = null;
  while (STATE.job && STATE.job.id === jobId && STATE.job.running) {
    let data;
    try {
      data = await api("GET", `/api/job/${encodeURIComponent(jobId)}?offset=${offset}`);
    } catch (err) {
      appendLog(pre, [`[ERROR] 读取任务日志失败：${err.message}`]);
      break;
    }
    if (Array.isArray(data.lines) && data.lines.length) appendLog(pre, data.lines);
    offset = typeof data.next_offset === "number" ? data.next_offset : offset + (data.lines || []).length;
    if (data.state !== "running") {
      final = data;
      STATE.job.running = false;
      break;
    }
    await sleep(600);
  }

  $("pub-cancel").hidden = true;
  if (!final) {
    setJobState("failed", null);
    showDoneNote(false, "任务中断：未能读取最终状态");
    return;
  }
  setJobState(final.state, final.rc);
  STATE.job = { id: jobId, running: false };

  if (final.state === "done") {
    const dryRun = $("pub-dry-run").checked && kind === "publish" && mode !== "force";
    if (dryRun) {
      showDoneNote(true, "演练完成：没有推送任何内容到远端。取消「演练模式」即可正式发布。");
    } else {
      const note = showDoneNote(true, "Cloudflare Pages 构建中，约 1-2 分钟");
      if (STATE.siteUrl) {
        const a = make("a", "link", STATE.siteUrl);
        a.href = STATE.siteUrl;
        a.target = "_blank";
        a.rel = "noopener";
        note.appendChild(a);
      }
    }
    toastOk("任务完成");
    refreshStatus().catch(() => {});
  } else if (final.state === "conflict") {
    const hint = $("pub-hint");
    clearNode(hint);
    hint.hidden = false;
    hint.append(
      make("strong", "", "推送被拒绝：远端有本地没有的提交。"),
      make("span", "", "先点「拉取合并」把远端提交合到本地再发布；确认要丢弃远端历史时，勾选「确认强制推送」后点「强制推送」。")
    );
    showDoneNote(false, `任务结束（conflict，rc=${final.rc}）`);
    toastError("推送冲突，需要处理远端提交");
  } else if (final.state === "canceled") {
    showDoneNote(false, "任务已取消");
    toastInfo("任务已取消");
  } else {
    showDoneNote(false, `任务失败（${final.state}，rc=${final.rc}）`);
    toastError(`任务失败（rc=${final.rc}）`);
  }
}

function showDoneNote(ok, text) {
  const note = $("pub-done");
  clearNode(note);
  note.className = ok ? "done-note" : "done-note is-error";
  note.hidden = false;
  note.appendChild(make("div", "", text));
  return note;
}

async function cancelJob() {
  if (!STATE.job || !STATE.job.running) {
    toastInfo("当前没有运行中的任务");
    return;
  }
  try {
    await api("POST", `/api/job/${encodeURIComponent(STATE.job.id)}/cancel`);
    toastInfo("已发送取消请求");
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `取消失败：${err.message}`);
  }
}

async function forcePush() {
  if (!$("pub-confirm-force").checked) {
    toastError("请先勾选「确认强制推送」");
    $("pub-confirm-force").focus();
    return;
  }
  const res = await confirmDialog(
    "强制推送",
    "强制推送会用本地历史覆盖远端 master，远端上多出的提交会丢失。\n确定继续吗？",
    { okText: "强制推送", danger: true }
  );
  if (!res.ok) return;
  await startPublishJob("publish", "force");
}

function loadPublish() {
  const pre = $("pub-log");
  if (!pre.textContent.trim()) pre.textContent = "（尚未运行任务）\n";
  if (!STATE.job) {
    const badge = $("pub-state");
    badge.className = "badge";
    badge.textContent = "空闲";
  }
}

/* ------------------------------------------------------------
   14. Git
   ------------------------------------------------------------ */
function xyClass(xy) {
  const s = String(xy || "");
  if (s.includes("D")) return "xy xy-del";
  if (s.includes("?") || s.includes("A")) return "xy xy-new";
  if (s.includes("M") || s.includes("R") || s.includes("C")) return "xy xy-mod";
  return "xy";
}

function renderDiff(pre, text) {
  clearNode(pre);
  if (!text || !String(text).trim()) {
    pre.appendChild(make("span", "l-dim", "（无差异内容）\n"));
    return;
  }
  for (const line of String(text).split("\n")) {
    let cls = "";
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("index "))
      cls = "head";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    const span = make("span", cls);
    span.textContent = line + "\n";
    pre.appendChild(span);
  }
  pre.scrollTop = 0;
}

async function loadGit() {
  const [st, log] = await Promise.all([
    api("GET", "/api/status"),
    api("GET", "/api/git/log?limit=20").catch(() => []),
  ]);
  STATE.status = st;
  const dirty = Array.isArray(st.dirty) ? st.dirty : [];
  $("git-sub").textContent = `分支 ${st.branch || "—"} · 领先 ${
    st.ahead == null ? "未知" : st.ahead
  } · 落后 ${st.behind == null ? "未知" : st.behind}`;
  $("git-dirty-count").textContent = String(dirty.length);

  const tbody = $("git-dirty");
  clearNode(tbody);
  if (!dirty.length) {
    const tr = make("tr");
    const td = make("td", "table-empty", "工作区干净，没有未提交的变更");
    td.colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const item of dirty) {
    const tr = make("tr");
    const tdXy = make("td");
    tdXy.appendChild(make("span", xyClass(item.xy), (item.xy || "").trim() || "??"));
    tr.appendChild(tdXy);
    tr.appendChild(make("td", "mono", item.path));
    const tdAct = make("td", "col-act");
    const btn = make("button", "btn btn-sm btn-danger", "回滚");
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      guard(() => restoreFile(item.path), btn);
    });
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    tr.addEventListener("click", () => {
      for (const other of tbody.querySelectorAll("tr")) other.classList.remove("is-selected");
      tr.classList.add("is-selected");
      guard(() => showDiff(item.path));
    });
    tbody.appendChild(tr);
  }

  const ul = $("git-commits");
  clearNode(ul);
  const commits = Array.isArray(log) ? log : [];
  if (!commits.length) {
    const li = make("li");
    li.appendChild(make("div", "table-empty", "暂无提交记录"));
    ul.appendChild(li);
  }
  for (const c of commits) {
    const li = make("li");
    const btn = make("button", "commit-btn");
    btn.type = "button";
    btn.append(
      make("span", "hash", c.hash || ""),
      make("span", "subj", c.subject || "(无提交信息)"),
      make("span", "when", (c.date || "").slice(0, 16))
    );
    btn.addEventListener("click", () => guard(() => toggleCommitShow(li, btn, c.hash)));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

async function showDiff(path) {
  const panel = $("git-diff-panel");
  const pre = $("git-diff");
  $("git-diff-path").textContent = path;
  panel.hidden = false;
  clearNode(pre);
  pre.appendChild(make("span", "l-dim", "加载中…\n"));
  const data = await api("GET", `/api/git/diff?path=${encodeURIComponent(path)}&staged=0`);
  renderDiff(pre, data && data.diff ? data.diff : "");
  panel.scrollIntoView({ block: "nearest" });
}

async function toggleCommitShow(li, btn, rev) {
  const existing = li.querySelector(".commit-show");
  if (existing) {
    existing.remove();
    return;
  }
  const pre = make("pre", "log commit-show");
  pre.appendChild(make("span", "l-dim", "加载中…\n"));
  li.appendChild(pre);
  const data = await api("GET", `/api/git/show?rev=${encodeURIComponent(rev)}`);
  clearNode(pre);
  const text = (data && data.text) || "";
  if (!text.trim()) {
    pre.appendChild(make("span", "l-dim", "（无输出）\n"));
    return;
  }
  for (const line of text.split("\n")) {
    let cls = "";
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("index "))
      cls = "head";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    else if (/^commit |^Author:|^Date:/.test(line)) cls = "l-status";
    const span = make("span", cls);
    span.textContent = line + "\n";
    pre.appendChild(span);
  }
}

async function restoreFile(path) {
  const res = await confirmDialog(
    "回滚文件",
    `确定丢弃 ${path} 的本地改动吗？\n该操作不可撤销，文件会恢复到最近一次提交的状态。`,
    { okText: "回滚", danger: true }
  );
  if (!res.ok) return;
  try {
    await api("POST", "/api/git/restore", { path });
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `回滚失败：${err.message}`);
    return;
  }
  toastOk(`已回滚 ${path}`);
  $("git-diff-panel").hidden = true;
  await loadGit();
  refreshStatus().catch(() => {});
}

/* ------------------------------------------------------------
   15. 事件绑定与启动
   ------------------------------------------------------------ */
function bindEvents() {
  window.addEventListener("hashchange", applyRoute);
  $("st-refresh").addEventListener("click", () =>
    guard(async () => {
      await refreshStatus();
      loadRoute(STATE.route);
      toastOk("已刷新");
    })
  );
  $("st-preview").addEventListener("click", togglePreviewFromBar);

  /* --- 仪表盘 --- */
  $("q-new-post").addEventListener("click", () => go("posts", newPostDialog));
  $("q-build-check").addEventListener("click", () => {
    go("publish", () => {
      $("pub-dry-run").checked = true;
      $("pub-skip-build").checked = false;
      return startPublishJob("publish", "normal");
    });
  });
  $("q-preview").addEventListener("click", () =>
    go("preview", async () => {
      if (!STATE.preview.running) await startPreview();
    })
  );

  /* --- 文章 --- */
  $("post-form").addEventListener("submit", (e) => {
    e.preventDefault();
    guard(() => savePost());
  });
  $("post-search").addEventListener("input", renderPostList);
  $("post-drafts-only").addEventListener("change", renderPostList);
  $("post-new").addEventListener("click", () => guard(newPostDialog));
  $("post-save").addEventListener("click", () => guard(() => savePost()));
  $("post-delete").addEventListener("click", () => guard(deleteCurrentPost));
  $("post-copy-path").addEventListener("click", () => guard(copyCurrentPath));
  $("post-upload").addEventListener("click", () => $("post-file").click());
  $("post-file").addEventListener("change", (e) => {
    guard(() => uploadFiles(e.target.files, $("post-body")));
    e.target.value = "";
  });

  const body = $("post-body");
  let previewTimer = null;
  body.addEventListener("input", () => {
    updatePostDirty();
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPostPreview, 200);
  });
  for (const id of ["pm-title", "pm-date", "pm-weight", "pm-author", "pm-tags", "pm-categories", "pm-description"]) {
    $(id).addEventListener("input", updatePostDirty);
  }
  $("pm-draft").addEventListener("change", updatePostDirty);

  body.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      body.classList.add("is-drop");
    }
  });
  body.addEventListener("dragleave", () => body.classList.remove("is-drop"));
  body.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      body.classList.remove("is-drop");
      guard(() => uploadFiles(e.dataTransfer.files, body));
    }
  });

  /* --- 设置 --- */
  $("set-mode-form").addEventListener("click", () => setSettingsMode("form"));
  $("set-mode-raw").addEventListener("click", () => {
    setSettingsMode("raw");
    if (STATE.settings && STATE.settings.raw && !$("set-raw").value.trim()) {
      $("set-raw").value = STATE.settings.raw;
    }
  });
  $("set-check").addEventListener("click", checkRawToml);
  $("set-save").addEventListener("click", saveSettings);
  $("set-reload").addEventListener("click", () => guard(() => loadSettings(true)));
  $("set-backups-refresh").addEventListener("click", () => guard(loadBackups));
  $("set-menu-add").addEventListener("click", () => {
    const tbody = $("set-menu");
    const empty = tbody.querySelector("tr:not([data-row])");
    if (empty) empty.remove();
    tbody.appendChild(menuRow({ identifier: "", name: "", url: "/", weight: tbody.querySelectorAll("tr[data-row]").length + 1 }));
    const last = tbody.lastElementChild;
    if (last) last.querySelector("input").focus();
  });

  /* --- 文件 --- */
  $("file-search-btn").addEventListener("click", () => guard(runSearch));
  $("file-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      guard(runSearch);
    }
  });
  $("file-results-close").addEventListener("click", closeSearchResults);
  $("file-save").addEventListener("click", () => guard(() => saveFile()));
  $("file-new").addEventListener("click", () => guard(newFileDialog));
  $("file-rename").addEventListener("click", () => guard(renameFileDialog));
  $("file-delete").addEventListener("click", () => guard(deleteFileDialog));
  $("file-download").addEventListener("click", downloadCurrentFile);
  $("file-upload").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => {
    guard(() => uploadFiles(e.target.files));
    e.target.value = "";
  });
  $("file-content").addEventListener("input", updateFileDirty);

  /* --- 预览 --- */
  $("pv-start").addEventListener("click", startPreview);
  $("pv-stop").addEventListener("click", stopPreview);

  /* --- 发布 --- */
  $("pub-start").addEventListener("click", () => guard(() => startPublishJob("publish", "normal")));
  $("pub-test").addEventListener("click", () => guard(() => startPublishJob("test-remote", "")));
  $("pub-pull").addEventListener("click", () => guard(() => startPublishJob("publish", "pull-rebase")));
  $("pub-force").addEventListener("click", () => guard(forcePush));
  $("pub-cancel").addEventListener("click", () => guard(cancelJob));

  /* --- Git --- */
  $("git-refresh").addEventListener("click", () => guard(loadGit));
  $("git-diff-close").addEventListener("click", () => {
    $("git-diff-panel").hidden = true;
    for (const tr of $("git-dirty").querySelectorAll("tr")) tr.classList.remove("is-selected");
  });

  /* --- 全局快捷键与离开提醒 --- */
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "s") {
      if (STATE.route === "posts" && STATE.currentPost) {
        e.preventDefault();
        guard(() => savePost());
      } else if (STATE.route === "files" && STATE.currentFile) {
        e.preventDefault();
        guard(() => saveFile());
      } else if (STATE.route === "settings") {
        e.preventDefault();
        saveSettings();
      }
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (updatePostDirty() || updateFileDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

async function boot() {
  bindEvents();
  if (!location.hash) location.hash = "#/dashboard";
  setSettingsMode("form");
  try {
    await refreshStatus();
  } catch (err) {
    toastError(err instanceof ApiError ? err.message : `读取状态失败：${err.message}`, 0);
    $("st-branch").textContent = "未连接";
  }
  applyRoute();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => guard(boot));
else guard(boot);
