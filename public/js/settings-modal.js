// PM 审计台 · 前端「设置弹窗」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

/* ---------- 设置弹窗 ---------- */

function updateSettingsUI() {
  $('#model').textContent = settings.model || '未配置模型';
  $('#side-status').textContent = settings.hasKey
    ? `${settings.model} · key ••••${settings.hint}`
    : settings.requiresKey === false ? settings.model : '未配置 API';
}

function openSettings() {
  openModal('API 设置', '密钥只保存在本机 .env。', (m) => {
    const providers = settings.providers?.length ? settings.providers : [
      { id: 'longcat', label: 'LongCat', baseUrl: 'https://api.longcat.chat/openai/v1', model: 'LongCat-2.5', requiresKey: true },
      { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresKey: true },
      { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', requiresKey: true },
      { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', requiresKey: false },
      { id: 'custom', label: '自定义', baseUrl: '', model: '', requiresKey: true },
    ];
    const provider = el('select');
    for (const item of providers) {
      const option = el('option', '', item.label);
      option.value = item.id;
      provider.append(option);
    }
    provider.value = settings.provider || 'longcat';
    field(m, '服务商', provider);

    const base = inputEl('text', 'https://…/v1', settings.baseUrl || '');
    field(m, 'Base URL', base, '填到 /v1；也兼容其他 OpenAI 格式地址。');
    const model = inputEl('text', '模型名', settings.model || '');
    field(m, '模型', model);
    const key = inputEl('password', settings.hasKey ? '留空保留当前 key' : 'sk-...');
    field(m, 'API Key', key, '更换服务商或地址后需重新填写；Ollama 无需 key。');

    const applyProvider = () => {
      const item = providers.find((entry) => entry.id === provider.value);
      if (!item) return;
      base.value = item.baseUrl;
      model.value = item.model;
      key.disabled = !item.requiresKey;
      key.placeholder = item.requiresKey ? 'sk-...' : '无需 key';
      if (!item.requiresKey) key.value = '';
    };
    provider.onchange = applyProvider;
    const current = providers.find((entry) => entry.id === provider.value);
    key.disabled = current ? !current.requiresKey : false;

    const msg = el('div');
    m.append(msg);
    actionsEl(m, [
      ['关闭', '', closeModal],
      [
        '保存',
        'primary',
        async (e) => {
          const btn = e.target;
          btn.disabled = true;
          try {
            const body = { provider: provider.value, baseUrl: base.value.trim(), model: model.value.trim() };
            if (key.value.trim()) body.apiKey = key.value.trim();
            const res = await fetch('/api/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
            settings = j;
            updateSettingsUI();
            msg.innerHTML = '';
            msg.append(el('div', 'okbox', `已保存：${j.model}`));
          } catch (err) {
            msg.innerHTML = '';
            msg.append(el('div', 'errbox', String(err.message)));
          } finally {
            btn.disabled = false;
          }
        },
      ],
    ]);
  });
}
