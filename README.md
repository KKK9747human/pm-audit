# PM 审计台

本地运行的进度审计工作台：读 GitHub 的提交、分支、PR 和 issue，按任务依赖图算状态、卡点和关键路径，可以就项目现状跟 AI 对话。支持多项目；数据包会自动写回对应仓库的 `.pm/<项目id>/`（仅管理员可写），别人打开同一项目时自动读取最新版。

只依赖 Node.js 18+ 和 `gh` CLI，没有 npm 依赖。

队友上手看随包提供的 `使用说明.md`（不在公开仓库内）：接管项目、绑定身份、日常同步/写回和常见问题都在里面。

## 启动

Windows：双击 `scripts\start.cmd`，浏览器会打开 http://127.0.0.1:7317；关闭用 `scripts\stop.cmd`。

macOS / Linux：

```sh
sh scripts/start.sh
sh scripts/stop.sh
```

手动启动：`node server.mjs`。

拉数据（命令行）：`node bin/pmctl.mjs audit <项目id> --fresh`，或双击 `scripts\refresh.cmd`。

## 配置

两种方式，效果一样，key 只写本机 `.env`：

1. 界面左下角「API 设置」；
2. 复制 `.env.example` 为 `.env`，填写 `PM_API_*`。

支持 LongCat、OpenAI、DeepSeek、Ollama 和自定义 OpenAI 兼容服务。默认接 LongCat（`https://api.longcat.chat/openai/v1`，模型 `LongCat-2.5`）；Ollama 可不填 key。切换服务商或 Base URL 后必须重新填写对应密钥，旧 key 不会沿用。

`.env` 已在 gitignore 里，不会进仓库，也不会写进导出的数据包。旧的 `LONGCAT_*` 配置仍可读取，保存新设置时会迁移为 `PM_API_*`。

## 项目

一个项目 = `projects/<id>/project.json` + `projects/<id>/plan.json`。

- 项目 id 只能用小写字母、数字、连字符。
- `plan.json` 里的节点：`id`、`title`、`owner`、`est`（S/M/L = 1/3/8 人日）、`deps`、`files`、`acceptance`。
- 界面侧栏「＋ 立项」走四步向导建项目；也可以放好 `project.json` / `plan.json` 再建。

审计结果写到：

- `data/<id>/bundle.pm.json`：完整数据包（计划和证据都在里面）
- `data/<id>/audit.md`：给人看的审计报告
- `data/<id>/trail.md`：证据链报告（完成节点 → 合并 PR → 提交 → 证据文件，附指纹校验）
- `data/<id>/onboarding.md`：agent 接入提示词（`pmctl onboard` 生成，整段粘进会话即可开工）
- `data/<id>/dag.mmd`：Mermaid 依赖图
- `data/<id>/interpretations/`：每次新提交的 AI 解读
- `data/<id>/agent/`：Agent 简报（`index.json` + `tasks/<节点>.md`），内容与本机身份绑定；`AGENT.md` 是给 AI 的生产指导，与身份无关
- `cache/<id>/raw.json`：GitHub 原始数据缓存
- `cache/<id>/published.json`：最近一次写回仓库的记录

## 换机器与接入已有项目

工具目录自带全部代码，换机器只要三步：

1. 装 Node.js 18+ 和 `gh`，运行 `gh auth login` 登录有权限的账号；
2. 把代码目录拷过去（`.env`、`data/`、`cache/`、`tmp/` 都可以不拷），在界面左下角选择模型服务并填自己的 key，或在新机器 `.env` 写 `PM_API_KEY=...`；
3. 接管仓库里已有的项目：`node bin/pmctl.mjs adopt --repo owner/name`（先加 `--dry-run` 只看不建）。

启动前可以跑 `node bin/pmctl.mjs doctor`：逐项检查 Node 版本、目录权限、gh 登录、模型 key、仓库可访问性、远端 `.pm/` 数据包和本机写权限；`--offline` 只做本地检查。

`adopt` 只读远端 `.pm/<id>/manifest.json` 和分片，按指纹重算校验通过才在本机建项目；本机已有同名项目会拒绝，改用 `sync`。

## 立项（新建项目）

浏览器里点侧栏「＋ 立项」，四步建完：

1. **项目底座**：项目 id、显示名称、GitHub 仓库、默认分支、本地仓库路径、成员代号。没有仓库时点同一页的「创建 GitHub 仓库」：先预览 owner/仓库名/可见性，确认后才调本机 `gh` 建一个带 README、默认分支 main 的空仓库；同名不覆盖，这一步也只建仓库、不建 PM 项目。
2. **调研**：填立项卡（一句话想法必填，其余选填），点「收集仓库资料并生成调研」。模型会读该仓库的 README、docs 和 open issue，加上立项卡和补充材料；**不联网检索**。事实必须带来源（`BRIEF`、`NOTE-1`、`DOC-n`、`ISSUE-n`），没来源的降级到「待验证」。生成的 Markdown 可以直接改；改调研会清空已生成的计划。
3. **计划**：从调研生成节点草稿，或在节点表里手改（id/标题/owner/est/依赖/文件/验收），也可以直接导入已有计划 JSON。进下一步前必须点「校验计划」通过：id 唯一、依赖存在且无环、est 只能是 S/M/L、owner 必须在成员表里、节点不超过 40 个。
4. **确认**：核对汇总后创建。只写本机 `projects/<id>/`（`project.json`、`plan.json`），带立项记录的再写 `intake.json` 和 `research.md`；不推送远端、不建分支、不改 GitHub。

创建后点「拉取数据」执行第一次审计。命令行等价入口：先写计划 JSON（参考 `plan/example.plan.json`），再 `node bin/pmctl.mjs project:add --id <项目id> --repo owner/name --plan path/to/plan.json`。

计划会先校验：id 唯一、依赖必须存在、不能有环、est 只能是 S/M/L；不合格会在创建前报错，不会留下半成品目录（服务端先写 `projects/.staging/` 再整体改名）。

没有现成计划时，也可以走命令行草稿：`node bin/pmctl.mjs plan-draft <id>`（已有项目，草稿写 `projects/<id>/plan.draft.json`）或 `plan-draft --repo owner/name [--local 路径]`（新项目，草稿写 `tmp/`）。需要模型 key。草稿只是草稿：节点、归属、验收都要人工逐条核对后再创建，PM 不会用它覆盖正式 `plan.json`；没读到文档也没有 issue 时直接报错，不编节点。

## 本机身份

PM 读 GitHub 前先认人：`gh api user --jq .login` 拿到 GitHub 登录名，再用 `git config user.email` 兜底，在项目的 `members[]` 里对上号。

- 顶栏显示 `登录名 · 负责的节点前缀`，例如 `alice · A`。
- 图里自己的节点带青色圆点，筛选多了「我的节点」。
- 对话和 Agent 简报都按这个身份走：知道哪些节点是自己的，哪些是别人的。

没对上号也能用，只是所有节点都按「别人的」处理。

## 两种对话

对话框右上切换挡位，选择记在浏览器里：

- **小白**：大白话、句子短、一次最多给三件事，命令可以直接照抄。
- **进阶**：直接给结论和依据，引用节点、分支、PR、sha，区分证据和推测，点出风险和取舍。

两种都只依据本项目的审计事实回答，可以继续追问。界面上 PM 的输出都带 PM 标识。

另外有一路给 AI 的：抽屉里的「Agent 下一步」和顶部的「Agent 简报」，按节点给出结构化简报，写入 `.pm/<id>/agent/`，agent 可以直接读。生产协议（版本核对、选任务顺序、写回证据、完成定义、禁止事项）单独写在 `.pm/<id>/AGENT.md`，所有节点简报都指向它。

## 证据怎么挂到节点

三种方式，任意一种即可：

- 分支命名 `task/<节点id>`，例如 `task/A2`
- issue / PR 正文里写 `<!-- pm:node=A2 -->`
- 提交或 PR 标题带 `[A2]`

没挂上的提交会列在「计划外提交」里。

给 AI 用的时候，PR 正文再多写一行 `<!-- pm:base=<简报里的指纹> -->` 声明基于哪版简报。PM 会拿它和当前指纹比对：对不上就在节点证据里标「基于旧简报」，并在顶部提示条里汇总；标记格式不对会标「base 标记无效」。

## 写回与同步

PM 会把数据包自动写回项目仓库的 `.pm/<id>/`，直推默认分支（例如 `main`）：

- 刷新数据后，如果事实指纹变了，自动提交一次；没变就不写。
- 写回内容：`manifest.json`、`bundle.parts/*.b64`（gzip 分片的 base64 文本，PM 自动拼接并校验 sha256）、`AGENT.md`（给 AI 的生产指导）、`trail.md`（证据链审计）、`agent/index.json`、`agent/tasks/*.md`、`interpretations/*.md`、`README.md`。
- 超过 1 MB 的数据包不能走 contents API，所以拆成固定长度的文本分片（每片 48,000 字符，约 65 KB），比单文件大响应稳得多。
- 打开项目时先比对 `.pm/<id>/manifest.json` 的指纹：本机一样就跳过，不一样就拉下来重算 `facts` 校验后覆盖本地。
- 顶栏「同步」手动拉一次；「写回」手动推一次；「自动」打开后每 10 分钟检查一次远端，有变化才刷新并写回。
- 刷新后如果指纹变了会自动写回，并顺手解读新提交：有新提交且分支上有 open PR 时，把解读作为评论发到 PR（带 `<!-- pm:watch=分支@sha -->` 去重标记，重复跑只更新不重发）。

### 自动审计闭环（watch）

`pmctl watch` 是一个本地常驻循环，把「刷新证据 → 重算事实 → 翻转节点状态 → 刷新证据链/本机催办/Agent 简报」串成闭环，不用人盯着手动 `audit`：

- **廉价探针**：每轮（默认 10 分钟）只取仓库 `pushed_at` + open PR 指纹两次轻量调用，和上轮比对。没变化就跳过，不跑昂贵的全量 `ingest`——GitHub 网络慢时尤其省。
- **有变化才重算**：探针发现真变化（新提交/PR 更新或合并）才 `audit --fresh` 全量重算，节点 done/stale/blocked/ready 随之翻转，`trail.md`、`alerts.json/.md`、简报一起刷新。
- **兜底全量**：即使探针没变化，每 `--full-every` 轮（默认 6，约 1 小时）也强制全量一次，兜住「只关 issue 没推代码」和「停滞天数随时间增长」这类探针看不到的变化。
- **写回只在真变化时**：加 `--publish` 才写回，且只在远端真有变化那轮写（兜底全量不写），避免指纹随刷新时间漂移导致每轮刷屏提交。冲突沿用单写者协议：409 → `sync` → 重算 → 只重试一次。
- **催办始终本机**：`alerts` 不写回 `.pm/`、不外发 GitHub，只在本地刷新。
- **稳健**：连续失败按 `interval × 2^n`（封顶 6 倍）退避；下一轮只在本轮跑完后才排程（`setTimeout` 链），天然不重叠。状态存 `cache/<id>/watch-state.json`。
- `--once` 只跑一轮（适合 cron/手动验证）；`--no-interpret` 关掉新提交解读（省模型调用与 PR 评论）。

> 顶栏「自动」开关走的是 server `/refresh?auto=1`，**与 `pmctl watch` 一样是探针门控的**（不是无条件全量）：每 10 分钟先跑一次廉价探针，远端无变化就直接跳过这一轮，既不跑全量 `audit --fresh`，也不写回仓库；只有远端确有变化（新提交、PR 更新或合并）才全量重算并写回。探针本身不可用时（网络失败、GitHub 响应过大、探针时间预算耗尽），自动轮次会放弃本轮而不是盲写，避免用旧快照覆盖唯一进度文件；每 6 轮还有一次兜底全量重算，兜底轮只更新本机、不写回，因此不会因刷新时间推进导致指纹漂移、每轮刷屏提交。
>
> 手动点「刷新数据」总是会本地重算一次，但同样只有远端真变化才写回。要常驻闭环、让催办和 Agent 简报也跟着刷新，用 `pmctl watch --publish`。

### 谁能改数据

项目进度数据（`project.json`、`plan.json`、`.pm/` 下的数据包和 manifest）只允许管理员修改。

- 管理员 = `project.json` 的 `admin`、`admins[]`，以及所有已绑定 `members[].github` 的成员；成员绑定 GitHub 登录名后自动获得管理权，没绑定的仍只读。
- 非管理员进入只读：刷新变成「从仓库同步」，写回、PR 备注、归位执行、解读评论都会被服务端拒绝（403）；审计图、对话、导出、归位命令照常可用。
- 同步时会检查 `.pm/<id>/manifest.json` 最后一次提交的作者是否在管理员列表里，不在就拒绝加载（`untrusted`），防止有人绕过 PM 手推数据。
- 这层限制管的是 PM 自己的写入；真正拦住越权写还要在 GitHub 上给 `.pm/` 配 CODEOWNERS 或分支保护规则。

### 只保留一个进度文件

- 远端进度只落一份：路径固定为 `.pm/<id>/`（bundle 分片 + manifest + Agent 简报），不按人或按分支分文件；写回整树覆盖并删除旧分片。
- 写回前比对远端 manifest：远端数据包比本地新时返回 409，提示先 `sync` 或刷新，避免用旧快照覆盖唯一进度文件。
- 多人同时写仍靠远端 ref 冲突兜底（422 非快进 → 409，先同步再重试）。

数据包格式 `pm-audit/bundle` v1：

- `asOf`：冻结时刻。所有「空闲几天」「是否停滞」都相对它算，不是相对导入时间。
- `plan`、`evidence`、`facts`：三份规范化 JSON（键排序、数组按 id/sha 排序）。
- `hashes`：三份内容的 SHA-256。

同步/导入时都用包内计划和证据重算 `facts`，指纹一致才接收。所以同一份包在任何机器上重算结果相同；不一致说明包被改过或版本不匹配，可以强制导入，但会明确标出来。

## PR 备注与归位

- 「发 PR 备注」把当前进度摘要（节点统计、关键路径、卡点）评论到指定 PR，带指纹去重标记，同一份数据重复发会更新原评论。
- 计划外提交可以「归位」：选一个节点，PM 在该分支的 open PR 上评论 `<!-- pm:node=ID -->`，让这条分支的提交重新挂到节点上；没有 open PR 时给出可照抄的 `gh pr comment` 命令。

## 证据链与 Agent 接入

- 工作台第 3 页「证据」：完成节点逐张卡片列出验收标准、合并 PR（日期、分支流向、diff 统计、pm:base 基准标签）、提交、证据文件，全部链接回 GitHub；页首显示指纹重算是否一致。不一致的数据包不当可信进度展示。
- `pmctl trail <id>` 生成 Markdown 版证据链；写回后仓库 `.pm/<id>/trail.md` 同步有一份。
- `pmctl onboard <id>` 生成通用接入提示词（模板 `templates/agent-onboarding.md`）：环境步骤、版本核对、选任务顺序、写回协议速查、汇报格式、禁止事项 + 当前快照。任何 agent 整段粘贴即可按协议开工；工作台「Agent 简报」弹窗里有复制按钮。

## 催办（本机提醒）

- 工作台第 2 页「催办」卡：把停滞（手上活停了）、卡点（被前置挡住）、待启动（没人动却卡着下游）三类节点按「关键路径 + 下游数」排序列出，每条给一句建议和一个「复制话术」按钮。
- `pmctl alerts <id>` 打印同一份清单，并写 `data/<id>/alerts.json` / `alerts.md`；每次 `audit` 也会刷新这两个文件。
- 只在本机提醒，**不会自动往 GitHub 发评论或 issue**。要催谁，复制话术自己发。

## 命令

```
node bin/pmctl.mjs list
node bin/pmctl.mjs audit [id|--all] [--fresh]
node bin/pmctl.mjs sync [id|--all]        # 从仓库 .pm/ 拉最新数据包
node bin/pmctl.mjs publish [id]           # 把本地数据包写回仓库 .pm/（仅管理员，非管理员会报错退出）
node bin/pmctl.mjs agent [id] [--json]    # 生成本机身份的 Agent 简报
node bin/pmctl.mjs onboard [id]           # 生成 agent 接入提示词（ stdout + data/<id>/onboarding.md）
node bin/pmctl.mjs trail [id]             # 生成证据链报告 data/<id>/trail.md
node bin/pmctl.mjs alerts [id]            # 催办清单（停滞/卡点/待启动），本机提醒不自动发 GitHub
node bin/pmctl.mjs pr-note <id> --pr <编号>      # 进度摘要评论到 PR
node bin/pmctl.mjs link <id> --branch <分支> --node <节点> [--run]   # 归位到 open PR
node bin/pmctl.mjs import <bundle.pm.json> [--force]
node bin/pmctl.mjs project:add --id x --name X --repo owner/name --plan plan.json [--local 路径]
node bin/pmctl.mjs plan-draft <id> | --repo owner/name [--local 路径] [--out 文件]   # 模型从文档/issue 拆计划草稿（需 key，不覆盖正式计划）
node bin/pmctl.mjs adopt --repo owner/name [--id x] [--dry-run]   # 新机器接管远端已有项目
node bin/pmctl.mjs doctor [id] [--offline]   # 环境与权限自检
node bin/pmctl.mjs issues [id]      # 只生成 issue 正文和 gh 命令，不自动提交
node bin/pmctl.mjs watch [id|--all] [--once] [--interval 分钟] [--publish] [--no-interpret] [--full-every N]   # 自动审计闭环：探针远端，有变化才重算+刷新本机催办，--publish 真变化时写回
```

也支持 `npm run sync` / `npm run publish` / `npm run agent` / `npm run doctor`；`npm test` 跑测试（node:test，无额外依赖）。

## 本机身份绑定

对不上成员时点顶栏的身份牌：列出项目成员，填 GitHub 登录名后保存，写进 `projects/<id>/project.json` 的 `members`，然后重新识别。

## 开发与发布

### 前端结构

前端是原生 JS（无框架、无构建），按职责拆成 `public/js/*.js`，由 `public/index.html` 按顺序加载：

| 文件 | 职责 |
| --- | --- |
| `core.js` | 基础工具与全局状态 |
| `security.js` | 公网 HTTP 的明文提示条 |
| `projects.js`、`paging.js` | 侧栏、项目切换、分页 |
| `overview.js`、`graph.js`、`progress.js` | 流程页、任务依赖图、进度页 |
| `evidence.js`、`chat.js`、`empty-state.js` | 证据链与 Agent 简报、对话、空状态 |
| `modal.js`、`settings-modal.js`、`import-modal.js`、`intake.js`、`help.js` | 各类弹窗与立项向导 |
| `events.js`、`boot.js` | 事件绑定、启动 |

脚本共享全局作用域，**加载顺序不能改**：`events.js` 必须排在 `boot.js` 前面，否则事件绑定会拿到未定义的函数。
`test/frontend-split.test.mjs` 守住这条约束（文件数、孤儿文件、单文件行数上限、`boot.js` 在最后）。

### 本地测试

```sh
npm test                                     # 全部单元测试（node:test，无额外依赖）
node test/lib/browser-acceptance.mjs        # 真浏览器验收（Edge/Chrome 无头，38 项断言）
```

单元测试不需要 `gh` 登录。浏览器验收需要本机装有 Edge 或 Chrome，默认找
`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，可用 `PM_TEST_BROWSER` 指定路径。

### CI

`.github/workflows/ci.yml`：Node 18 / 20 / 22 / 24 上跑测试（Linux 全版本 + Windows 一个版本），
并跑一次 `pmctl doctor --offline` 环境自检。

### 发布到公开仓库

本地仓库是全量的（含队内文档、参赛材料、真实项目数据），公开仓库只放工具本体。
用脚本同步，不要手工拷：

```sh
node scripts/publish-public.mjs          # 同步到 out/public-repo 并报告差异
node scripts/publish-public.mjs --push   # 同步后提交并推送
```

脚本按白名单取文件，推送前做泄露扫描：队内文档、真实账号 / 仓库名、疑似密钥都会让流程中止。
确实需要公开的字符串，逐行写进 `tmp/publish-allow.txt`（该目录不入库）。

### HTTPS

本机默认 `http://127.0.0.1:7317`，流量不出本机，不需要 HTTPS。
要对外提供服务时，两种做法：

1. 给 PM 自己配证书：`PM_TLS_CERT` / `PM_TLS_KEY`（文件路径）或 `PM_TLS_CERT_PEM` / `PM_TLS_KEY_PEM`（PEM 内容），
   配好后服务跑在 `https://127.0.0.1:7317`，并自动带上 HSTS 等安全响应头；
2. 在前面套一层 TLS 反代（推荐用于公网网关）。

完整步骤见 `deploy/README.md`。

工作台在「非 HTTPS 且非回环地址」访问时会在顶部提示：填写的 GitHub Token 和模型 API key 会明文传输。

## 生产使用检查清单

- 仓库侧：给 `.pm/` 配 CODEOWNERS（例如 `/.pm/ @你的账号`）并开启默认分支保护。PM 的管理员门禁只是本机身份判断，真正拦住越权写要靠 GitHub 规则。
- 单写者：同一项目同一时间只让一台机器开启自动写回；两台同时写会返回 409 冲突，提示先同步再重试。所有管理员共用同一份远端进度文件，不要导出或手建第二份。
- 备份：远端 `.pm/` 就是数据备份；本地 `data/`、`cache/` 丢了用 `sync` 或 `adopt` 恢复。
- 自检：换机器或升级后跑 `node bin/pmctl.mjs doctor` 和 `npm test`。
- 模型 key 只写本机 `.env`；没有 key 时审计和写回照常，只有对话与提交解读不可用。

## 常见故障

- `gh` 找不到或未登录：装 GitHub CLI 后 `gh auth login`，再跑 `doctor` 确认。
- 403 只读模式：本机 gh 登录名不在管理员列表（`admin` / `admins[]` / 已绑定 github 的成员）；先把登录名绑到 `members[].github`，或改 `project.json` 的 `admin`。
- 写回 409：远端进度比本地新，或远端分支在发布期间被更新（多半是另一台机器写了回）；先 `sync` 或刷新再 `publish`。
- `adopt` 分片读取失败：GitHub 网络不稳，直接重试；`doctor` 会先报告仓库可达性。
- 没有模型 key：审计、写回、Agent 简报都正常，只有对话和提交解读不可用。

## 现状

- issue 创建只生成命令，需要人确认后执行。
- 立项向导会调模型生成调研与计划草稿，但只在本机写项目文件；计划不校验通过就不能创建。GitHub 建仓只在用户点按钮后执行，其它流程不会自动建仓。
- 计划草稿可由模型从仓库文档/issue 拆解（`plan-draft`），但只是草稿，必须人工逐条核对后才创建；PM 不自动覆盖正式计划。
- PM 自己的写回提交（消息以 `[PM]` 开头）会被 watch 跳过，不会自问自答。
- 服务默认只监听 `127.0.0.1`；需要对外提供服务时自己配证书或套 TLS 反代，见「开发与发布 / HTTPS」。
- 公开仓库只放工具本体，发布走 `scripts/publish-public.mjs`，脚本会拦住队内文档与真实身份信息。
