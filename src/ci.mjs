export function mapCheckRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  return {
    id: run.id ?? null,
    name: run.name || '未命名检查',
    status: run.status || null,
    conclusion: run.conclusion ?? null,
    head_sha: run.head_sha || null,
    url: run.html_url || run.details_url || null,
    started_at: run.started_at || null,
    completed_at: run.completed_at || null,
  };
}

const UNFINISHED = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']);
const FAILURES = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

export function summarizeChecks({ runs = null, headSha = null, complete = false, truncated = false, collectionReason = null } = {}) {
  const mapped = Array.isArray(runs) ? runs.map(mapCheckRun) : null;
  const list = mapped?.filter(Boolean) || [];
  const malformed = mapped?.some((r) => !r || typeof r.status !== 'string' ||
    (r.conclusion !== null && typeof r.conclusion !== 'string'));
  const validHead = typeof headSha === 'string' && /^[0-9a-f]{40}$/i.test(headSha);
  const sourceMatches = validHead && list.every((r) => r.head_sha === headSha);
  truncated = Boolean(truncated);

  // Acquisition completeness is explicit evidence, not an execution verdict.
  // Do not silently drop malformed records or let a partial success imply passed.
  const problems = [];
  if (typeof collectionReason === 'string' && collectionReason) problems.push(collectionReason);
  if (mapped === null) problems.push('没有采集到 CI 检查结果');
  else if (malformed) problems.push('CI 检查记录格式异常');
  if (!validHead) problems.push('缺少有效的 PR head（需要完整 40 位十六进制 SHA）');
  else if (!sourceMatches) problems.push('检查结果不是当前 PR head，或缺少检查来源 SHA');
  if (truncated && !problems.some((reason) => reason.includes('截断'))) problems.push('CI 检查列表被截断');
  if (complete !== true && !problems.length) problems.push('未确认 CI 检查采集完整');
  collectionReason = problems.length ? problems.join('；') : null;
  const acquired = complete === true && collectionReason === null;
  const result = (status, reason) => ({
    status,
    reason: collectionReason && !reason.includes(collectionReason) ? `${reason}；${collectionReason}` : reason,
    complete: acquired,
    truncated,
    collectionReason,
    headSha: typeof headSha === 'string' && headSha ? headSha : null,
    checks: list,
  });

  if (!validHead || !sourceMatches || mapped === null || malformed) {
    return result('unknown', collectionReason);
  }
  if (!list.length) return result('unknown', '当前没有 CI 检查记录');
  const failures = list.filter((r) => FAILURES.has(r.conclusion));
  if (failures.length) return result('failed', `发现 ${failures.length} 个明确失败的检查`);
  const pending = list.filter((r) => UNFINISHED.has(r.status) || UNFINISHED.has(r.conclusion));
  if (pending.length) return result('pending', `还有 ${pending.length} 个检查未完成`);
  if (acquired && list.every((r) => r.status === 'completed' && r.conclusion === 'success')) {
    return result('passed', '已采集的 CI 检查全部成功');
  }
  return result('unknown', '检查结论不足以证明全部通过');
}
