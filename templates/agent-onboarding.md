# PM 接入提示词（整段复制进你的 agent 会话）

你现在以执行 agent 的身份加入 **{{PROJECT_NAME}}**（仓库 `{{REPO}}`）。这个项目用 PM 审计台管进度：节点状态由 PM 从 GitHub 证据算出来，你的口头汇报不算进度。按下面的顺序做，不要跳步。

## 0. 环境（一次性，约 3 分钟）

1. 需要 Node 18+ 和已登录的 gh CLI（`gh auth status` 确认）。
2. 拿到 PM 审计台代码包并解压，进入目录。
3. 接管项目：`node bin/pmctl.mjs adopt --repo {{REPO}} --id {{PROJECT_ID}} --branch {{BRANCH}}`
4. 自检：`node bin/pmctl.mjs doctor {{PROJECT_ID}}`。出现 fail 先解决；网络类 warn 可稍后重试。
5. 打开工作台（可选）：`npm start` → http://127.0.0.1:7317 。

## 1. 每轮开工先核对版本

- 读 `.pm/{{PROJECT_ID}}/manifest.json` 的 `hash`，与 `.pm/{{PROJECT_ID}}/agent/index.json` 的 `hash` 对比。
- 不一致：先 `node bin/pmctl.mjs sync {{PROJECT_ID}}`，再读新简报。
- 离线无法同步：本轮汇报里必须写明你基于哪个 hash 干活。
- 生产规范唯一来源是 `.pm/{{PROJECT_ID}}/AGENT.md`；节点细节在 `agent/tasks/<节点>.md`。本提示词与它冲突时以 AGENT.md 为准。

## 2. 选任务

1. 你名下的节点（见下方「当前快照」）。
2. 关键路径上的 ready / active 节点。
3. 其余节点先问负责人或 PM，不要自己挑。
4. blocked 的节点停手等依赖，不要绕开或造假接口。

## 3. 写回约定（协议速查）

| 动作 | 约定 |
|---|---|
| 分支 | `task/<节点ID>`，一个节点一个分支一个 PR |
| 提交标题 | 带 `[<节点ID>]`，如 `[A2] 修复采集参数` |
| PR 正文 | `<!-- pm:node=<节点ID> -->`；要自动关 issue 再加 `Closes #<issue>` |
| PR 正文 | `<!-- pm:base=<当前指纹> -->`，声明基于哪版简报 |
| 完成判定 | 只有 PR 合并或 issue 关闭才记 done；本地提交不算 |
| 范围 | 一次一个节点，验收标准之外不顺手改 |
| 数据包 | `.pm/**` 只读；进度写回由管理员单写者负责，你不要 publish |

## 4. 汇报格式

节点｜分支｜sha/PR｜做了什么｜验收逐条对照（没做写「未完成+原因」，不写「基本完成」）｜剩余风险｜基于的数据版本（asOf + hash）。

## 5. 禁止

- 不手改 `.pm/**`、`data/**`、`plan.json`；计划要改找管理员。
- 不把密钥、令牌写进仓库、提交、PR 或汇报。
- 不伪造完成状态，不在依赖未确认时批量改多个节点。
- 证据挂不上（分支/标题/标记都没有）：汇报里给出分支和 sha，让 PM 手动归位。

## 当前快照

- 项目：{{PROJECT_NAME}}（`{{PROJECT_ID}}`）｜仓库 `{{REPO}}`｜默认分支 `{{BRANCH}}`
- 数据基准：{{ASOF}}｜指纹 `{{HASH}}`
- 规模：{{STATS}}
- 关键路径：{{CRITICAL}}
- 你名下节点：{{OWNED}}
- 管理员（数据包写回者）：{{ADMINS}}