import fs from 'node:fs';
import path from 'node:path';

// 2026-10-26 主人定：评论默认 @ 主人（测试用小猫）；另有 55% 的概率**不**再 @ 别人，
// 剩下的概率在「主人以外的白名单好友」之间平分。人数不写死——白名单加减人，概率自动跟着分。
export const EXTRA_MENTION_NONE = 0.55;
export const DEFAULT_MASTER_NAME = String(process.env.DOUYIN_MENTION_NAME || '测试用小猫').trim();

// 只读许可好友名单（备注在里面的 alias）；读不到就当空名单，不影响评论。
export function readChatAllowlist(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDir, 'chat-policy.json'), 'utf8'));
    const list = Array.isArray(value?.allowlist) ? value.allowlist : [];
    return list
      .filter((item) => item && typeof item.id === 'string' && item.id && typeof item.name === 'string' && item.name.trim())
      .map((item) => ({ id: item.id, name: item.name.trim(), alias: typeof item.alias === 'string' ? item.alias.trim() : '' }));
  } catch { return []; }
}

// 返回 { id, name, alias } 或 null。random 可注入，方便测试。
export function pickExtraMention({ allowlist = [], excludeName = DEFAULT_MASTER_NAME, random = Math.random, none = EXTRA_MENTION_NONE, onRoll } = {}) {
  const master = String(excludeName || '').trim();
  const candidates = (Array.isArray(allowlist) ? allowlist : []).filter((item) => item && String(item.name || '').trim() && String(item.name).trim() !== master);
  if (!candidates.length) return null;
  const roll = Number(random());
  const report = (picked) => { try { onRoll?.({ candidates: candidates.length, roll, none, picked: picked ? picked.name : null }); } catch { /* 诊断不影响主流程 */ } };
  if (!Number.isFinite(roll) || roll < 0 || roll < none) { report(null); return null; }
  const span = Math.max(1e-9, 1 - none);
  const index = Math.min(candidates.length - 1, Math.floor(((roll - none) / span) * candidates.length));
  report(candidates[index]);
  return candidates[index];
}

// 2026-10-26：临时覆盖用。state/mention-roll.json 写 {"none":0} 就变成「每次都 @ 第二个人」，
// 用来验证浏览器里插第二个 @ 到底通不通；文件删掉就回到 55%。
export function mentionNoneProbability(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDir, 'mention-roll.json'), 'utf8'));
    const none = Number(value?.none);
    if (Number.isFinite(none) && none >= 0 && none <= 1) return none;
  } catch { /* 没有覆盖就用默认 */ }
  return EXTRA_MENTION_NONE;
}
