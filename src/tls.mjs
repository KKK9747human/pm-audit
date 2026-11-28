import { readFileSync } from 'node:fs';

// 可选的原生 TLS 配置。
// 证书路径写 PM_TLS_CERT / PM_TLS_KEY（.env 或进程环境变量均可），
// 或直接给 PEM 内容 PM_TLS_CERT_PEM / PM_TLS_KEY_PEM（多行内容只能走进程环境变量）。
// 没配就走明文 HTTP —— 本机默认就是 http://127.0.0.1。
export function resolveTls(env = {}) {
  const certPem = env.PM_TLS_CERT_PEM;
  const keyPem = env.PM_TLS_KEY_PEM;
  if (certPem && keyPem) return { cert: certPem, key: keyPem };
  const certPath = env.PM_TLS_CERT;
  const keyPath = env.PM_TLS_KEY;
  if (!certPath || !keyPath) return null;
  try {
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } catch (err) {
    throw new Error(`读取 TLS 证书失败：${err.message}`);
  }
}
