// PM 审计台 · 前端「使用说明弹窗」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

/* ---------- 说明 ---------- */

function openHelp() {
  openModal('使用说明', '本地优先，数据可随身带走。', (m) => {
    const sec = (t, html) => {
      m.append(el('h4', '', t));
      const p = el('p', 'tip');
      p.innerHTML = html;
      m.append(p);
    };
    sec('启动 / 关闭', '双击 scripts\\start.cmd 启动，scripts\\stop.cmd 关闭；浏览器打开 http://127.0.0.1:7317。');
    sec('数据从哪来', 'gh 读远程仓库的 issue、PR、分支、提交；本机有仓库目录时优先用本地 git。所有时间以 asOf 为基准，结果可复现。');
    sec('立项', '侧栏「＋ 立项」四步走完：项目底座 → 调研 → 计划 → 确认。调研和计划都由模型出草稿、你来改；进入确认前计划必须通过校验。创建只写本机 <code>projects/&lt;id&gt;/</code>（project.json、plan.json、intake.json、research.md），不推送远端。「创建 GitHub 仓库」按钮需要本机 gh 已登录，只在你点了之后才建仓。');
    sec('数据包在仓库里', '刷新后指纹变化会自动写回 <code>.pm/&lt;项目&gt;/</code>（bundle、manifest、每个节点的 Agent 简报）。别人打开 PM 时会先读 manifest，发现有更新就自动拉取并校验；手动入口是右上「同步」「写回」。');
    sec('谁能改数据', '管理员 = <code>project.json</code> 的 <code>admin</code>、<code>admins[]</code>，以及所有已绑定 <code>members[].github</code> 的成员；未绑定登录名的成员仍是只读。写回、PR 备注、归位执行只对管理员开放，同步时也会校验远端 <code>.pm/</code> 最后一次提交作者是否在管理员列表里。');
    sec('只有一个进度文件', '进度数据只落一份：仓库里固定为 <code>.pm/&lt;项目&gt;/</code> 的 bundle + manifest + Agent 简报，不按人分文件；写回会整树覆盖并删除旧分片。若远端数据包比本地新，写回返回 409 并提示先同步或刷新，避免用旧快照覆盖唯一的进度文件。');
    sec('只读用户能做什么', '照样看审计图、卡点、关键路径、问对话、导出数据包；能拿到归位命令并复制给管理员执行。要改进度数据，请先把 GitHub 登录名绑到成员上，再由本人刷新并写回。');
    sec('两种对话', '「小白」挡讲人话，直奔下一步；「进阶」挡给结论、证据和取舍。两种都会先标出你的身份和负责的节点。');
    sec('给 Agent 的简报', '点对话卡片的「Agent 简报」或节点详情里的「复制节点简报 md」。生产指导在 <code>.pm/&lt;项目&gt;/AGENT.md</code>，节点简报绑验收、依赖、证据和下一步，位于 <code>.pm/&lt;项目&gt;/agent/</code>。');
    sec('本机身份', 'PM 用 <code>gh api user</code> 和 <code>git config user.email</code> 识别你是谁，映射到项目的 members[].github；识别不到就只显示账号，不影响审计。');
    sec('分享给别人', '点右上「导出」得到 <code>.bundle.pm.json</code>。对方导入后会用包内计划和证据重算 SHA-256 指纹，一致才接收；不一致可以强制导入，但会标出来。');
    sec('API 配置', '支持 LongCat、OpenAI、DeepSeek、Ollama 和自定义 OpenAI 兼容服务。密钥只写本机 .env，不进前端、数据包或仓库。');
    sec('证据怎么挂到节点', '分支命名 <code>task/A2</code>；issue/PR 正文写 <code>&lt;!-- pm:node=A2 --&gt;</code>；提交或 PR 标题带 <code>[A2]</code>。');
    sec('命令行', '<code>node bin/pmctl.mjs audit &lt;id&gt; --fresh</code> 拉数据；<code>sync</code> / <code>publish</code> 同步与写回；<code>agent &lt;id&gt;</code> 生成本机简报；<code>watch --once</code> 解读新提交。');
    actionsEl(m, [['知道了', 'primary', closeModal]]);
  });
}
