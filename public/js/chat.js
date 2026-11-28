// PM 审计台 · 前端「对话」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

/* ---------- 对话 ---------- */

function scrollChat() {
  const c = $('#chat');
  c.scrollTop = c.scrollHeight;
}

function msgEl(role, content) {
  const m = el('div', `msg ${role}`);
  if (role === 'assistant') m.innerHTML = mdLite(content);
  else m.textContent = content;
  return m;
}

function renderChat(id) {
  const box = $('#chat');
  box.innerHTML = '';
  const msgs = chats.get(id) || [];
  if (!msgs.length) {
    const empty = el('div', 'chat-empty');
    empty.append(el('div', 'ce-title', '和 PM 对话'));
    empty.append(
      el(
        'div',
        'ce-sub',
        chatMode === 'beginner'
          ? '用大白话问：现在真正卡在哪里、我今天该做什么。PM 会把术语拆开讲。'
          : '问进度、问取舍、问卡点根因。PM 会引用节点号、分支和证据。',
      ),
    );
    empty.append(el('div', 'ce-hint', '下面可以直接点一个问题开始'));
    box.append(empty);
    return;
  }
  for (const m of msgs) box.append(msgEl(m.role, m.content));
  scrollChat();
}

function renderMode() {
  const seg = $('#mode');
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === chatMode));
  const hint = $('#chat-hint');
  if (hint) hint.textContent = chatMode === 'beginner' ? '小白挡 · 讲人话' : '进阶挡 · 讲证据';
}

function renderPrompts() {
  const box = $('#prompts');
  box.innerHTML = '';
  const sets = {
    beginner: ['现在真正卡住的是什么？', '我今天该从哪一步开始？', '这个术语是什么意思？'],
    advanced: ['关键路径为什么这么排？', '哪条线最可能拖期？', '计划外提交里有哪些风险？'],
  };
  for (const p of sets[chatMode]) {
    const b = el('button', '', p);
    b.onclick = () => ask(p);
    box.append(b);
  }
}

async function ask(text) {
  const q = text.trim();
  if (!q || streaming || !currentId || !facts || projectLoading) return;
  const ctx = projectContext();
  streaming = true;
  $('#send').disabled = true;
  $('#q').value = '';
  const msgs = chats.get(currentId) || [];
  chats.set(currentId, msgs);
  msgs.push({ role: 'user', content: q });
  const box = $('#chat');
  box.querySelector('.chat-empty')?.remove();
  box.append(msgEl('user', q));

  const bot = el('div', 'msg bot pending', '思考中…');
  box.append(bot);
  scrollChat();

  let acc = '';
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (!acc && bot.isConnected) bot.textContent = `思考中… ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);

  const projectId = currentId;
  try {
    const res = await fetch(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: msgs.slice(-10), mode: chatMode }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    if (!isCurrent(ctx)) { await res.body?.cancel(); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (!isCurrent(ctx)) { await reader.cancel(); return; }
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.trim().startsWith('data:'));
        if (!line) continue;
        const data = line.trim().slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new Error(j.error);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          acc += delta;
          if (bot.isConnected) {
            bot.classList.remove('pending');
            bot.textContent = acc;
            scrollChat();
          }
        }
      }
    }
    if (!acc) acc = '（空回复）';
    if (bot.isConnected) {
      bot.classList.remove('pending');
      bot.className = 'msg bot';
      bot.innerHTML = mdLite(acc);
    }
    msgs.push({ role: 'assistant', content: acc });
  } catch (err) {
    if (bot.isConnected) {
      bot.className = 'msg err';
      bot.textContent = `出错了：${String(err.message).slice(0, 300)}`;
    }
  } finally {
    clearInterval(timer);
    if (isCurrent(ctx)) {
      streaming = false;
      updateProjectActions();
      if (autoSyncReloadPending) {
        autoSyncReloadPending = false;
        autoSync(projectId);
      }
    }
  }
}
