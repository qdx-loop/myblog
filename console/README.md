# myblog-console — 本地博客控制台

给 `/home/qdx/myblog`（Hugo + PaperMod）用的本机浏览器控制台：写文章、可视化改设置、一键构建校验并提交推送、管理文件、查看 Git、实时预览。

- 只监听 `127.0.0.1:8787`，无登录（非本机来源与非法 Host 头一律 403）。
- 零外部依赖安装：优先用系统 `python3`（本机已装 Flask + PyYAML），缺失时 `run.sh` 自建 `.venv` 兜底。前端原生 HTML/CSS/JS，无 CDN、无 npm、无构建步骤。
- 不含任何凭据。GitHub token（可选）只存在仓库外的 `~/.config/myblog-console/config.json`（权限 0600）。

## 启动

```sh
bash console/run.sh            # 启动并自动打开浏览器
bash console/run.sh --no-open  # 只启动，不打开浏览器
PORT=9000 bash console/run.sh  # 换端口
```

然后浏览器访问 `http://127.0.0.1:8787`。停止：终端按 `Ctrl-C`（会顺带关掉预览用的 `hugo server`）。

环境变量 `MYBLOG_ROOT` 可覆盖仓库根（默认 `/home/qdx/myblog`）。

## 七个标签页

| 标签 | 作用 |
|---|---|
| 仪表盘 | 站点信息（标题、baseURL、文章/草稿数、Hugo 版本、分支、最近提交）+ 快捷按钮（新建文章 / 构建校验 / 启动预览） |
| 文章 | 左侧列表（搜索、仅草稿、按日期排序），右侧 front matter 表单 + CodeMirror Markdown 编辑器 + 实时预览；新建/保存/删除/上传图片；`Ctrl+S` 保存 |
| 设置 | 表单模式可视化改 `hugo.toml`（保留注释，41 项覆盖站点/显示/首页/搜索/内容输出/Markdown/评论/菜单），或原文模式整文件编辑 + 校验；备份列表可恢复 |
| 文件 | 全仓库目录树、按后缀高亮的编辑器、二进制下载、新建/重命名/删除（回收站）、全文搜索（命中行自动定位高亮） |
| 预览 | 启停 `hugo server`（`127.0.0.1:1313`），内嵌 iframe 看真实站点 |
| 发布 | 提交信息、范围（仅 posts / 全部）、构建校验选项、演练模式；开始发布 / 连通性测试 / 拉取合并 / 强制推送，带实时日志 |
| Git | `git status` 变更列表（看 diff、单文件回滚）、最近提交（看 `git show`）、领先/落后计数 |

## 编辑器

文章正文与文件编辑器用 **CodeMirror 5.65.16**（MIT），已随仓库放在 `console/static/vendor/codemirror/`，**不依赖 CDN/npm**。

- 按文件后缀自动选高亮：Markdown 用 `gfm`（标题/粗体/代码/引用/列表分色），`toml`、`yaml`、`json`、`js`、`css`、`html`、`xml`、`sh` 同理。
- 行号、当前行高亮、括号匹配、自动闭合括号、Markdown 列表回车续写。
- 快捷键：`Ctrl+S` 保存、`Ctrl+F` 查找、`Shift+Ctrl+F` 替换、`Ctrl+/` 切换注释、`Ctrl+B` 粗体、`Ctrl+I` 斜体、`Tab`/`Shift+Tab` 缩进。
- 工具栏：粗体、斜体、标题、行内代码、代码块、链接、图片、无序列表、有序列表、引用、分隔线。
- 图片可直接拖到编辑器里上传并插入 Markdown；正文下方实时预览与字数统计。
- 文件页搜索命中行会自动选中并短暂高亮；二进制文件显示「不可编辑」+ 下载链接。

## 设置面板覆盖的键

| 分组 | 键 |
|---|---|
| 站点 | `title` `baseURL` `locale` `theme` `languageCode` `defaultContentLanguage` `copyright` `enableRobotsTXT` `enableEmoji` `buildDrafts` |
| 显示 | `params.author` `defaultTheme` `dateFormat` `ShowReadingTime` `ShowShareButtons` `ShowPostNavLinks` `ShowBreadCrumbs` `comments` `enableSearch` |
| 首页 | `params.homeInfoParams.Title` `.Content` |
| 搜索 | `params.search.enable` `.limit`；`params.search.fuseOpts.keys` `threshold` `location` `distance` `isCaseSensitive` |
| 内容与输出 | `params.mainSections`、`outputs.home`（保留 JSON，否则搜索索引失效） |
| Markdown 渲染 | `markup.goldmark.renderer.unsafe` `hardWraps` |
| 评论 Waline | `params.waline.enable` `serverURL` `placeholder` `login` `requiredMeta` `wordLimit` `pageSize` `upload` `emoji` |
| 导航菜单 | `[[menu.main]]` 的 `identifier` `name` `url` `weight` |

表单模式「按表定位、只改值」：未改动的键不写盘、不产生备份；缺省键在首次改动时插入到正确表（如 `[markup.goldmark.renderer]` 不存在则追加整表）。其余未列入表单的配置原样保留，也可用原文模式整体编辑。

## 运行期数据（都在仓库外：`~/.config/myblog-console/`）

```
config.json   # {"port":8787,"root":"/home/qdx/myblog","github_token":"","trash_keep_days":30}  权限 0600
backups/      # hugo.toml.<YYYYmmdd-HHMMSS>  每次设置保存前的原文备份
trash/        # <UTC时间戳>/<原相对路径>      删除的文件（非永久删除，默认保留 30 天）
askpass.sh    # 仅当配置了 github_token 时生成，供 HTTPS 推送鉴权
```

删除的文件不会进系统回收站，而是移到 `trash/`；确认无误后可手动清空该目录。

## 发布与传输链

发布 job 顺序：`git status` → （可选）`pull --rebase` → 构建校验 → 暂存 → `commit` → 推送。
推送按以下传输链逐条回退，任一成功即停：

1. **HTTPS** `https://github.com/qdx-loop/myblog.git` —— 匿名读可用；推送需凭据。配置 `github_token`（GitHub PAT）后通过 `GIT_ASKPASS` 生效，无需改代码。
2. **SSH:22** `git@github.com:qdx-loop/myblog.git`
3. **SSH:443** `ssh://git@ssh.github.com:443/...`（22 端口被网络阻断时的后路）

> 传输可用性随网络环境变化：实测同一台机器在不同时间 22 端口时通时断，故保留三条回退链。
> 「演练模式」用 `git push --dry-run`，走同一鉴权路径但不改远端。
> 推送成功后由 **Cloudflare Pages** 自动构建部署，通常 1–2 分钟，站点 `https://lsx.cc.cd/`。

配置 token：

```sh
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home()/".config/myblog-console/config.json"
c = json.loads(p.read_text()); c["github_token"] = "ghp_xxx"
p.write_text(json.dumps(c, ensure_ascii=False, indent=2))
PY
```

## 设置面板注意事项

- 表单模式「按表定位、只改值」，**保留 `hugo.toml` 里的注释**；值未变化的键不写盘（幂等，无 churn）。
- 保存前自动备份原文；解析失败一律 400 且**不写盘**；写后还会校验解析值与提交值一致。
- **菜单**：保存菜单会重写所有 `[[menu.main]]` 块，菜单块**内部的注释会丢失**（当前文件的菜单块内无注释，故无影响）。菜单未变时不重写。
- 已知历史问题：原 `hugo.toml` 把 `enableSearch` 误写在 `[params.homeInfoParams]` 下（Hugo 实际读 `params.enableSearch`）。控制台在「显示」分组里把它作为 `params.enableSearch` 正确读写；若你从未改过它，面板会显示 `false`（即 `params` 下当前确实没有该键）。改一次即可在 `[params]` 下写入正确位置。
- 只读展示项 `outputs.home = ["HTML","RSS","JSON"]` 与 `mainSections = ["posts"]`：**搜索索引依赖 JSON 输出，请勿删除**。

## API 一览

所有路径都是仓库相对路径（如 `content/posts/start.md`）。改动类接口需要 GET 返回的 `etag`；etag 过期返回 409 `{"error":"conflict","current_etag":...,"current_content":...}`。

```
GET  /api/status                         站点/分支/变更/领先落后/预览状态
GET  /api/tree?dir=&depth=1              目录列表
GET  /api/file?path=                     读文件（含 etag/binary）
GET  /api/file/download?path=            下载
PUT  /api/file      {path,content,etag}  保存（409 冲突检测）
POST /api/file/new  {path,content}       新建（存在则 409）
POST /api/file/rename {from,to}          重命名/移动
POST /api/file/delete {path}             移入回收站
GET  /api/search?q=&limit=50             全文搜索
GET  /api/posts                          文章列表
GET  /api/post?path=                     读文章（meta/body/etag）
PUT  /api/post      {path,meta,body,etag}保存文章
POST /api/post/new  {title,tags,...}     新建文章（自动 slug + weight）
GET  /api/meta                           tags/categories/weights 补全
POST /api/upload    (multipart file,dir) 上传图片，返回 markdown 语法
GET  /api/settings                       设置表单 + 原文 + 菜单 + 只读项
PUT  /api/settings  {mode:form|raw,...}  保存设置（form 改值/raw 整文件）
GET  /api/settings/backups               备份列表
POST /api/settings/restore {name}        恢复备份
POST /api/hugo/check {raw}               试解析 TOML（不写盘）
GET  /api/git/log?limit=                 提交历史
GET  /api/git/diff?path=&staged=         diff
GET  /api/git/show?rev=                  单提交详情
POST /api/git/restore {path}             回滚单文件
POST /api/job/publish {...}              发布任务，返回 {id}
POST /api/job/test-remote                连通性测试任务，返回 {id}
GET  /api/job/<id>?offset=               轮询任务日志与状态
POST /api/job/<id>/cancel                取消任务
POST /api/preview/start|stop             启停 hugo server
GET  /api/preview/status                 预览状态 + 日志尾巴
```

### curl 示例

```sh
B=http://127.0.0.1:8787

# 看站点状态
curl -s $B/api/status | jq '{branch,posts,drafts,hugo}'

# 改站点标题（表单模式，保留注释，自动备份）
curl -s $B/api/settings | jq -c '{mode:"form",values:{title:"我的博客"},menu:.menu}' \
  | curl -s -X PUT $B/api/settings -H 'Content-Type: application/json' -d @- | jq '.ok'

# 跑一次发布演练（不改远端），然后轮询日志
JID=$(curl -s -X POST $B/api/job/publish -H 'Content-Type: application/json' \
  -d '{"message":"演练","scope":"posts","skip_build":false,"dry_run":true}' | jq -r .id)
watch -n1 "curl -s $B/api/job/$JID?offset=0 | jq -r '.state, (.lines[-5:][]|tostring)'"
```

## 目录结构

```
console/
├── app.py            Flask 应用：路由、校验、任务运行器、预览进程管理
├── gitops.py         git 子进程封装 + 传输回退链
├── frontmatter.py    YAML front matter 解析/生成（date 保持字符串）
├── toml_edit.py      hugo.toml 按表定位改值（保留注释）+ 校验
├── run.sh            启动器
├── README.md         本文件
└── static/
    ├── index.html / app.js / style.css   前端
    └── vendor/codemirror/                CodeMirror 5.65.16（MIT，本地）

```
