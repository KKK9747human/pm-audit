// PM 审计台 · 前端「连接安全提示」
// 公网用 HTTP 时，GitHub Token 与模型 API key 都是明文传输；本机回环不算。

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isEncryptedPage() {
  if (location.protocol === 'https:') return true;
  return LOCAL_HOSTS.has(location.hostname);
}

function renderSecurityBanner() {
  const box = $('#insecure-banner');
  if (!box) return;
  if (isEncryptedPage()) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent =
    '当前连接未加密（HTTP）：你填写的 GitHub Token 和模型 API key 会明文传输。建议改用 HTTPS 访问，或只在可信网络里使用。';
}

renderSecurityBanner();
