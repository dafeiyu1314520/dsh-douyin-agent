import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateCommentText } from './autonomous-comments.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const cid = value => typeof value === 'string' && /^\d{1,64}$/.test(value);

function read(file, fallback) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw Error();
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw fail('回复记录无法核对，未重置许可或待核对收据。');
  }
}
function write(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

// 每条作品最多回 4 次；同一条回复只回一次（永久去重）。不回自己的评论。
export const REPLY_LIMITS = Object.freeze({ perVideo: 4, perCheck: 2, maxTextLength: 200 });

export class AutonomousReplies {
  constructor({ videoLimits, stateDir = resolveRuntimePaths().stateDir, source = 'api', now = Date.now } = {}) {
    if (!videoLimits?.state || !['api', 'dsh'].includes(source) || typeof now !== 'function') throw new TypeError('回复服务缺少有限视频时钟或可信入口。');
    Object.assign(this, { videoLimits, stateDir, source, now });
    this.files = {
      policy: path.join(stateDir, 'replies-policy.json'),
      ledger: path.join(stateDir, 'replies-ledger.json'),
      lock: path.join(stateDir, 'replies-check.guard'),
    };
    this.busy = null;
  }
  policy() {
    const value = read(this.files.policy, { version: 1, enabled: false });
    if (!value || value.version !== 1 || typeof value.enabled !== 'boolean') throw fail('回复许可损坏，未继续回复。');
    // 2026-10-26 主人定：每部作品的回复次数改成可配置（默认仍是 4）。
    const perVideo = value.perVideo === undefined ? REPLY_LIMITS.perVideo : value.perVideo;
    if (!Number.isSafeInteger(perVideo) || perVideo < 1 || perVideo > 50) throw fail('每部作品回复次数须在 1 至 50 之间，未继续回复。');
    const account = name => (typeof name === 'string' && name.length <= 64 && !/[\x00-\x1f]/.test(name) ? name.trim() : '');
    return { version: 1, enabled: value.enabled, masterAccount: account(value.masterAccount), selfAccount: account(value.selfAccount), perVideo };
  }
  configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('回复许可只能由用户在本机设置。', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'masterAccount', 'selfAccount', 'perVideo'].includes(key))) throw fail('回复设置只接受开关和两个账号名。', 400);
    const current = this.policy();
    const next = {
      version: 1,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
      masterAccount: input.masterAccount === undefined ? current.masterAccount : String(input.masterAccount).trim(),
      selfAccount: input.selfAccount === undefined ? current.selfAccount : String(input.selfAccount).trim(),
      perVideo: input.perVideo === undefined ? current.perVideo : Number(input.perVideo),
    };
    if (!Number.isSafeInteger(next.perVideo) || next.perVideo < 1 || next.perVideo > 50) throw fail('每部作品回复次数须是 1 至 50 的整数。', 400);
    if ([next.masterAccount, next.selfAccount].some(name => name.length > 64 || /[\x00-\x1f]/.test(name))) throw fail('账号名最多 64 字且不能含控制字符。', 400);
    if (next.masterAccount && next.selfAccount && next.masterAccount.normalize('NFKC') === next.selfAccount.normalize('NFKC')) throw fail('主人账号和大肥鱼账号不能是同一个。', 400);
    write(this.files.policy, next);
    return this.state();
  }
  ledger() {
    const value = read(this.files.ledger, { version: 1, operations: [] });
    if (!value || value.version !== 1 || !Array.isArray(value.operations) || value.operations.some(item =>
      !item || !identifier(item.operationId) || !cid(item.videoId) || !cid(item.targetId) || !cid(item.parentId) ||
      typeof item.text !== 'string' || !item.text || [...item.text].length > REPLY_LIMITS.maxTextLength ||
      !['pending', 'confirmed', 'not-sent', 'uncertain'].includes(item.status) ||
      item.status === 'confirmed' && !cid(item.replyId))) throw fail('回复记录损坏，未重新计数。');
    return value;
  }
  operationsForVideo(videoId) { return this.ledger().operations.filter(item => item.videoId === videoId); }
  answered(targetId) { return this.ledger().operations.some(item => item.targetId === targetId); }
  state() {
    const policy = this.policy(), ledger = this.ledger(), time = this.videoLimits.state();
    return {
      protocol: 'autonomous-replies-v1',
      enabled: policy.enabled,
      masterAccount: policy.masterAccount,
      selfAccount: policy.selfAccount,
      allowed: Boolean(policy.enabled && time.allowed),
      timeReason: time.allowed ? null : time.reason,
      limits: { perVideo: policy.perVideo, perCheck: REPLY_LIMITS.perCheck },
      counts: { total: ledger.operations.length, confirmed: ledger.operations.filter(item => item.status === 'confirmed').length },
      paused: ledger.operations.some(item => ['pending', 'uncertain'].includes(item.status)),
      recent: ledger.operations.slice(-10).map(({ operationId, videoId, targetId, text, status, replyId, startedAt }) => ({ operationId, videoId, targetId, text, status, replyId, startedAt })),
    };
  }
  reserve({ videoId, parentId, targetId, targetAuthor, text }) {
    if (!cid(videoId) || !cid(parentId) || !cid(targetId)) throw fail('回复必须有可核对的作品、评论和回复编号。', 400);
    text = validateCommentText(text);
    const policy = this.policy(), ledger = this.ledger();
    if (ledger.operations.some(item => item.targetId === targetId)) throw fail('这条回复已经处理过，未重复回复。', 409);
    // 主人账号不计入每条作品的 4 次上限（2026-10-24 主人定）。
    const master = Boolean(policy.masterAccount) && String(targetAuthor || '').normalize('NFKC').trim() === policy.masterAccount.normalize('NFKC');
    if (!master && ledger.operations.filter(item => item.videoId === videoId && item.status !== 'not-sent' && !item.master).length >= policy.perVideo) throw fail(`这条作品已经回复过 ${policy.perVideo} 次，未继续。`, 409);
    if (ledger.operations.some(item => ['pending', 'uncertain'].includes(item.status))) throw fail('上一条回复结果未核对，已暂停。', 409);
    const operation = { operationId: randomUUID(), videoId, parentId, targetId, text, master, status: 'pending', source: this.source, startedAt: new Date(this.now()).toISOString() };
    ledger.operations.push(operation); write(this.files.ledger, ledger);
    return operation;
  }
  update(operationId, patch) {
    const ledger = this.ledger(), item = ledger.operations.find(row => row.operationId === operationId);
    if (!item) throw fail('回复预留记录丢失，未继续。');
    Object.assign(item, patch); write(this.files.ledger, ledger); return item;
  }
  resolve({ operationId, outcome } = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('只有用户核对后才能解除暂停。', 403);
    if (!identifier(operationId) || !['not-sent', 'confirmed'].includes(outcome)) throw fail('请提供待核对回复编号和结果。', 400);
    const ledger = this.ledger(), item = ledger.operations.find(row => row.operationId === operationId);
    if (!item || !['pending', 'uncertain'].includes(item.status)) throw fail('没有这条待核对回复。', 400);
    item.status = outcome; item.reviewedAt = new Date(this.now()).toISOString(); write(this.files.ledger, ledger);
    return this.state();
  }
}
