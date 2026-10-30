import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiAgent, redact, watchDecisionMessages, parseWatchDecision, fullTranscript } from './api-agent.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { AutonomousShare } from './autonomous-share.mjs?v=9';
import { AutonomousComments } from './autonomous-comments.mjs?v=9';
import { PublicCommentAgent } from './public-comment-agent.mjs?v=11';
import { ReplyAgent } from './reply-agent.mjs?v=1';
import { ReplyService } from './reply-service.mjs?v=1';
import { DailyReport } from './daily-report.mjs?v=9';
import { appendWatchEntry, appendPrivateEntry } from './diary-writer.mjs?v=3';
import { sendToast } from './toast.mjs?v=1';
import { pickExtraMention, readChatAllowlist, mentionNoneProbability } from './mention-picker.mjs';
import { dedupeFramesByTime } from './frame-composite.mjs';
import { CaptureSession } from './capture-session.mjs';
import { cleanupOldMedia } from './media-cleanup.mjs';

// 单轮不再设请求上限：时长本身就是硬边界，另留每天 400 次做兜底（2026-10-24 主人定，原 200）。
// 2026-10-27 主人定：视频开头 3 秒叫「采样」，1.5 秒一张（3 张）；同一条作品之后的「观察」
// 采样/观察都先拼成一张图再送给模型。
// 2026-10-28 主人定：中间的观察窗口也放慢到 5 秒一张（3 张覆盖 10 秒），和 like 作品一致；
// 采样始终 3 秒/1.5 秒，评论用的采样也不例外。
// 2026-10-28 主人定：开头采样改成 1.5 秒一张、共 6 张（7.5 秒窗口），用来决定看不看这条。
// 2026-10-29 主人定：采样改成 5 秒、每秒一张（canvas 抽帧，5 格拼一张）判看不看；
// 那 2 张页面截图只留作 persona 证据，不进模型。
// sampleCells：采样图几格（2026-10-29 主人定 6 张、拉到第 6 秒）；sampleFrames 是留给 persona 的截图数。
export const WATCH_LIMITS = Object.freeze({ dailyLimit: 400, sampleSeconds: 6, sampleCells: 6, sampleFrames: 2, observeSeconds: 10, hotObserveSeconds: 10 });
// maxFrames = 6：喜欢后的拼图最多 6 格（3 张观察 + 3 张中段帧），3×2 布局。
// 2026-10-28：不再逐次决策后，一条作品的整条时间线都要进评论的那一次调用，故事板 8 → 14 张（10 秒一张≈140 秒）。
// 2026-10-29 主人定：评论的画面用「抽帧故事板」——整条视频最多 3 张、每张 9–16 格，不铺满。
// 关掉这个开关就退回原来的「采样 + 每次观察」拼图。
export const WATCH_STORYBOARD = Object.freeze({ enabled: true, maxSheets: 3 });
// 2026-10-29 主人定（A 方案）：采样决策只带开头 10 秒内的弹幕，按赞取前 8 条（实测 +70~110 token）。
export const WATCH_SAMPLING_DANMAKU = Object.freeze({ enabled: true, seconds: 10, limit: 8 });
export const WATCH_COMPOSITE = Object.freeze({ enabled: true, columns: 3, cellHeight: 0, cropRightPx: 90, cropBottomPx: 220, storyboardMax: 14, maxFrames: 6 });
// 时长是唯一硬边界以后，消耗主要来自“每条作品一次决策”。这几档由宿主自己计时，不额外花请求：
// 12 秒以内的短片直接看到尾；模型给 10–19 秒的停留，同一条连看到 20 秒；
// 给 20 秒以上（明确表示“值得看”），同一条最多连看 25 秒再重新采样。
// 2026-10-22 22:15 主人定：5 分钟/2 分钟太长了，一轮里同一条常常只够一次决策，音频判断也来不及进下一次决策。
// 两档一起收到 25 秒（2026-10-24 主人嫌评论慢，再把 40 缩到 25），同一条作品每 25 秒就有一次新判断，
// 代价是每分钟的决策数变多：约 1.5 次/分钟 ≈ 7k token/分钟。
// hotChunkSeconds：决策里出现 like 信号（额外感兴趣）时，这条作品的采样从 20 秒缩到 5 秒，换下一条自动恢复。
// 2026-10-22 23:10 主人定：10 秒仍然太稀，连续两张截图看不出画面在动 → 5 秒一张。
// hotStaySeconds：喜欢后的连看段单独封顶 20 秒（2026-10-27 主人定）；20 秒停留刚好是
// 5/10/15 + 20/25/30 六格全 5 秒，没有 25 秒那版的 10 秒空档。普通作品仍是 25 秒。
export const WATCH_PACING = Object.freeze({ microSeconds: 12, mildSeconds: 25, deepSeconds: 25, chunkSeconds: 20, hotChunkSeconds: 5, hotStaySeconds: 20, diaryMinSeconds: 30 });
// 2026-10-24 主人定：**超过 3 分钟**的作品，看到 **80%** 就算「看完」，可以进评论机会，不用死等结尾。
// 短视频仍然看到结尾；这条只放宽长片，避免一轮 5 分钟全耗在一条 4 分半的实况上。
export const LONG_VIDEO = Object.freeze({ minDuration: 180, ratio: 0.8 });
// ⚠️ 临时测试档（主人 2026-10-23 17:14 定，测完要恢复）：刷到 <2 分钟的作品就强制看到底，
// 然后直接发一条评论，不再问“要不要评”。恢复原逻辑只需把 enabled 改成 false。
export const TEST_SHORT_COMMENTS = Object.freeze({ enabled: false, maxSeconds: 120 });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('自主观看状态文件损坏，未重置预算或运行锁。'); } };
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const failure = (message, watchStatus = 'failed') => Object.assign(new Error(message), { watchStatus });

// API 与原生入口通过同一锁、有限视频轮次和持久预算协调，不在重启时恢复循环。
export class AutonomousWatch {
  constructor({ controller, config = {}, videoLimits, personaMemory, agent, shareService, commentService, commentAgent, reportService, decisionProvider, stateDir = resolveRuntimePaths().stateDir, source = 'api', fetchImpl = fetch, now = Date.now, delayImpl = (ms, signal) => delay(ms, undefined, { signal }), onEvent = () => {} } = {}) {
    if (!controller?.execute || !videoLimits?.state || !personaMemory?.context || !['api', 'dsh'].includes(source)) throw new Error('自主观看缺少浏览器、时限或共同人格接口。');
    Object.assign(this, { controller, config, videoLimits, personaMemory, shareService, decisionProvider, stateDir, source, now, delayImpl, onEvent });
    this.agent = agent || new ApiAgent({ controller, config, personaMemory, fetchImpl });
    Object.assign(this, { commentService, reportService });
    this.commentAgent = commentAgent || new PublicCommentAgent({ config, fetchImpl });
    this.replyAgent = new ReplyAgent({ config, fetchImpl });
    fs.mkdirSync(stateDir, { recursive: true });
    this.files = Object.fromEntries(['lock', 'guard', 'budget', 'state', 'stop'].map(name => [name, path.join(stateDir, `watch-${name === 'lock' ? 'loop.lock' : name === 'guard' ? 'control.guard' : name === 'stop' ? 'stop.request.json' : name + '.json'}`)]));
    this.files.manual = path.join(stateDir, 'watch-manual.lock');
    // local fix：按住热键暂停。热键脚本维护这个文件，存在即"按住"，消失即"松开"。
    this.holdFile = path.join(stateDir, 'watch-hold.flag'); this.held = false;
    this.running = false; this.completion = null; this.abort = null; this.runId = null; this.sessionId = null; this.lastRaiseAt = 0; this.track = null;
    this.diaryStats = { written: 0, skipped: 0, failed: 0, privateWritten: 0, rewriteCalls: 0, rewriteTokens: 0, lastAt: '', lastVideoId: '' };
    this.diaryStatsFile = path.join(stateDir, 'watch-diary.json');
  }
  control(action) {
    let descriptor; const token = randomUUID();
    try { descriptor = fs.openSync(this.files.guard, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('自主观看控制记录正被使用，请稍后重试。'), { status: 409, code: 'WATCH_CONTROL_BUSY' }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    try { return action(); } finally { const current = read(this.files.guard, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.files.guard); }
  }
  worker() {
    const worker = read(this.files.lock, null);
    if (!worker) return null;
    if (worker.version !== 1 || typeof worker.runId !== 'string' || typeof worker.sessionId !== 'string' || !['api', 'dsh'].includes(worker.source) || !Number.isSafeInteger(worker.pid)) throw new Error('自主观看锁格式无效，请核对原记录。');
    return { ...worker, alive: alive(worker.pid), owned: worker.runId === this.runId && worker.pid === process.pid };
  }
  budget() {
    const value = read(this.files.budget, { version: 1, sessions: {}, days: {} });
    if (!value || value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) || Object.values(value.sessions).some(item => !item || !Number.isSafeInteger(item.requests) || item.requests < 0) || Object.values(value.days).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('自主观看预算损坏，未重新计数。');
    return value;
  }
  state() {
    const worker = this.worker(), saved = read(this.files.state, {}), time = this.videoLimits.state();
    const sessionId = worker?.sessionId || time.session?.id || saved.sessionId || null;
    const budget = this.budget(), counts = budget.sessions[sessionId] || { requests: 0 };
    const request = read(this.files.stop, null), stopping = worker?.alive && request?.runId === worker.runId;
    return redact({ protocol: 'autonomous-watch-v1', running: Boolean(worker?.alive), owned: Boolean(worker?.owned), worker, status: stopping ? 'stopping' : worker?.alive ? 'running' : ['running', 'stopping'].includes(saved.status) ? 'stopped' : saved.status || 'stopped', sessionId, counts: { ...counts, dailyRequests: budget.days[day(this.now())] || 0, dailyLimit: WATCH_LIMITS.dailyLimit }, lastDecision: saved.lastDecision || null, lastUsage: saved.usage || null, diary: read(this.diaryStatsFile, null) || saved.diary || null, lastError: saved.lastError || '', pacing: saved.pacing || null, payload: saved.payload || null, remainingSeconds: time.allowed && time.session?.id === sessionId ? time.remainingSeconds : 0 }, [this.config.apiKey]);
  }
  /** 一轮结束时弹一条 Windows 通知（借 dsh-douyin-scroll 的 toast，2026-10-24）。永不抛。 */
  notifyRoundEnd(result) {
    try {
      const d = this.diaryStats || read(this.diaryStatsFile, null) || {};
      const minutes = Math.max(1, Math.round((this.now() - (this.runStartedAt || this.now())) / 60000));
      const status = result?.status || 'completed';
      const label = status === 'failed' ? '中断' : status === 'stopped' ? '被停' : status === 'limited' ? '时间到' : '结束';
      let body = `看了 ${Number(d.written || 0)} 条 · 用时 ${minutes} 分钟`;
      if (Number(d.privateWritten || 0)) body += ` · 私人本 ${Number(d.privateWritten)} 条`;
      if (status === 'failed' && result?.reason) body = String(result.reason).slice(0, 140);
      sendToast({ title: `大肥鱼 · 自主观看${label}`, body });
    } catch { /* 通知发不出去不影响那一轮 */ }
  }
  save(value) { write(this.files.state, redact({ ...read(this.files.state, {}), ...value, source: this.source, sessionId: this.sessionId, updatedAt: new Date(this.now()).toISOString() }, [this.config.apiKey])); }
  assertAllowed() {
    this.abort?.signal.throwIfAborted();
    const worker = this.worker(); if (!worker?.owned) throw failure('自主观看已失去运行锁，停止操作。');
    const time = this.videoLimits.state();
    if (!time.allowed || time.session?.id !== this.sessionId) throw failure(time.reason || '视频轮次已变化，原自主观看已停止。', 'limited');
    return time;
  }
  reserveRequest() {
    return this.control(() => {
      this.assertAllowed(); const budget = this.budget(), session = budget.sessions[this.sessionId];
      if (!session) throw failure('当前轮次的观看记录已丢失，请重新开始一轮。', 'limited');
      const key = day(this.now()); if ((budget.days[key] || 0) >= WATCH_LIMITS.dailyLimit) throw failure('今天的自主观看请求预算已用完。', 'limited');
      session.requests++; budget.days[key] = (budget.days[key] || 0) + 1; write(this.files.budget, budget); return session.requests;
    });
  }
  claimManual(kind) {
    const token = randomUUID();
    this.control(() => {
      if (this.worker()) throw Object.assign(new Error('请先停止共享自主观看，再执行手动任务。'), { status: 409 });
      const manual = read(this.files.manual, null);
      if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口的手动任务或转发仍在执行。'), { status: 409 });
      write(this.files.manual, { pid: process.pid, token, kind });
    });
    return async () => {
      for (let attempt = 0; ; attempt++) {
        try { return this.control(() => { const manual = read(this.files.manual, null); if (manual?.pid === process.pid && manual.token === token) fs.unlinkSync(this.files.manual); }); }
        catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
      }
    };
  }
  start({ startSession = false } = {}, { explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('自主观看只能由用户明确启动。'), { status: 403 });
    if (typeof startSession !== 'boolean') throw Object.assign(new Error('自主观看参数无效。'), { status: 400 });
    if (!this.decisionProvider && !this.config.apiKey) throw Object.assign(new Error('请先配置 API Key，再启动自主观看。'), { status: 400 });
    if (this.running || this.completion) throw Object.assign(new Error('当前自主观看正在执行或结束。'), { status: 409 });
    read(this.files.state, {});
    this.control(() => {
      const worker = this.worker(); if (worker) throw Object.assign(new Error(worker.alive ? '另一个入口已有自主观看运行。' : '上次自主观看留下运行锁，请先点击停止清理残留。'), { status: 409 });
      const manual = read(this.files.manual, null); if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口正在运行手动任务或转发。'), { status: 409 });
      if ((this.budget().days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw Object.assign(failure('今天的自主观看预算已用完。', 'limited'), { status: 409 });
      let time = this.videoLimits.state();
      if (!time.allowed && startSession) time = this.videoLimits.markSession(this.source, { explicit: true });
      if (!time.allowed) throw Object.assign(new Error(time.reason || '请先开启有限视频轮次。'), { status: 409 });
      const budget = this.budget(), session = budget.sessions[time.session.id];
      if (session) delete session.maxRequests;
      else budget.sessions[time.session.id] = { requests: 0 };
      if ((budget.days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw Object.assign(failure('今天的自主观看预算已用完。', 'limited'), { status: 409 });
      this.personaMemory.initialize?.({ importLegacy: false });
      write(this.files.budget, budget);
      this.runId = randomUUID(); this.sessionId = time.session.id;
      write(this.files.lock, { version: 1, pid: process.pid, runId: this.runId, sessionId: this.sessionId, source: this.source, status: 'running', heartbeatAt: this.now() });
    });
    this.abort = new AbortController(); this.running = true; this.startedDate = day(this.now()); this.track = null;
    this.runStartedAt = this.now();
    this.diaryStats = { written: 0, skipped: 0, failed: 0, privateWritten: 0, rewriteCalls: 0, rewriteTokens: 0, lastAt: '', lastVideoId: '' };
    this.diaryChain = Promise.resolve();
    try {
    this.save({ status: 'running', lastError: '', lastDecision: null });
    this.heartbeat = setInterval(() => {
      try {
        const request = read(this.files.stop, null); if (request?.runId === this.runId) this.abort.abort(failure('用户停止自主观看。', 'stopped'));
        this.assertAllowed();
        this.control(() => { const worker = this.worker(); if (!worker?.owned) throw failure('自主观看锁已改变。'); write(this.files.lock, { ...worker, heartbeatAt: this.now() }); });
        const hold = this.isHeld();
        if (hold !== this.held) {
          this.held = hold;
          this.controller.execute(hold ? 'douyin_pause' : 'douyin_play', {}, { signal: this.abort.signal, autonomousRunId: this.runId })
            .then(() => this.onEvent({ type: hold ? 'watch.held' : 'watch.resumed', message: hold ? '按了一下暂停键，视频已暂停；再按一下继续。' : '继续看了。' }))
            .catch(() => {});
        }
        // 连看 25 秒一段、90 秒才采样一次，提窗不能只靠 observe：运行期间每 15 秒顶一次窗口，
        // exe 自带 1.5 秒空闲保护，用户正在敲键盘/点鼠标时不抢前台。
        if (!this.held && this.now() - (this.lastRaiseAt || 0) >= 15_000) { this.lastRaiseAt = this.now(); try { this.controller.raiseWindow?.(); } catch {} }
      } catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY') this.abort.abort(error); }
    }, 500); this.heartbeat.unref?.();
    const remaining = this.videoLimits.state().session.expiresAt - this.now();
    this.deadline = setTimeout(() => this.abort.abort(failure('本轮刷视频时间已用完。', 'limited')), Math.max(1, Math.min(remaining, 2_147_483_647))); this.deadline.unref?.();
    this.completion = Promise.resolve().then(() => this.run()).catch(error => { this.onEvent({ type: 'watch.failed', message: redact(error.message || String(error), [this.config.apiKey]) }); return { running: false, status: 'failed', reason: redact(error.message || String(error), [this.config.apiKey]) }; }).then(result => { this.notifyRoundEnd(result); return result; }).finally(() => { this.completion = null; });
    return this.state();
    } catch (error) {
      clearInterval(this.heartbeat); clearTimeout(this.deadline); this.running = false;
      this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); this.runId = null;
      throw error;
    }
  }
  // 谁的轮询会短暂打开私信面板、占同一个标签页：私信自动回复，以及续火花问候。
  // 2026-10-26：原来只认 chat-loop.lock，续火花跑起来时它的会话读取不算「有人在用页面」，
  // 观看轮次照样会被判 needs_user——两个锁都算。
  chatPolling() {
    const alive = (file) => {
      try {
        const worker = JSON.parse(fs.readFileSync(path.join(this.stateDir, file), 'utf8'));
        if (!Number.isSafeInteger(worker?.pid) || worker.pid < 1) return false;
        try { process.kill(worker.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
      } catch { return false; }
    };
    return alive('chat-loop.lock') || alive('spark-loop.lock');
  }
  async execute(name, args = {}) {
    this.assertAllowed();
    // 2026-10-25：私信处理分享视频时会按住推荐流（watch-hold.flag）。原来只有观察循环会等，
    // 评论/换条这些工具照样执行，结果在私信占着页面时去判评论 → 整轮 needs_user（实测 15:40:08）。
    if (this.isHeld()) { try { this._captureSession?.hold('私信按住'); } catch { /* 切段失败不影响观看 */ } await this.waitWhileHeld(); }
    // 2026-10-24 21:40：私信轮询要打开面板读消息，原来的 privateChatVisible 判定会把整轮自主观看判死
    // （watch-state 里那句「抖音页面需要手动处理」就是它）。现在先等面板关掉，等不到再按原逻辑失败。
    // 2026-10-25：开轮第一次 douyin_status 也要等——私信服务跟这一轮同时启动时，chat.begin() 正开着
    // 面板读会话，第一眼就会判 privateChatVisible → 整轮 needs_user（实测 23:26 那轮，一条决策都没发就死了）。
    // 2026-10-26：只对「要动页面」的工具等私信收工。douyin_status 是只读的，等下去会把这一次停留的
    // 墙钟时间拖过 persona 的 30 秒上限（实测 13:30 那轮就是这么死的），所以状态读取照旧立刻做。
    if (name !== 'douyin_status' || this._firstProbe) {
      // 2026-10-25：私信面板不一定是"正在轮询"时才开着——上一轮失败会把面板留在页面上，
      // 这时开轮第一眼就看到 privateChatVisible，整轮直接判 needs_user（实测 15:13:43）。
      // 现在先等两拍；还在就自己把它关掉，再等一拍，实在关不掉才按原逻辑失败。
      const started = this.now();
      const probes = this._firstProbe ? 12 : 4;
      for (let attempt = 0; ; attempt += 1) {
        let state;
        try { const probe = await this.controller.execute('douyin_status', {}, { signal: this.abort.signal, autonomousRunId: this.runId }); state = probe?.state || probe; }
        catch { break; }
        if (!state?.privateChatVisible) break;
        const polling = this.chatPolling();
        // 私信还在轮询就继续等（面板是它开的）；不在轮询时最多等原来的几拍。
        if (!polling && attempt >= probes - 1) break;
        if (this.now() - started > 90_000) break;
        if (attempt === 1 && !polling) {
          try {
            await this.controller.withPage(async page => page.evaluate(() => {
              const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
              const buttons = [...document.querySelectorAll('.StackLayoutStackTitleBarcloseImPage')].filter(visible);
              buttons.at(-1)?.click();
            }), { signal: this.abort.signal });
          } catch { /* 关不掉就继续等 */ }
        }
        await this.delayImpl(1200, this.abort.signal);
      }
    }
    const output = await this.controller.execute(name, args, { signal: this.abort.signal, autonomousRunId: this.runId }); this.assertAllowed();
    if (name === 'douyin_status') this._firstProbe = false;
    const state = output?.state || output;
    // 2026-10-26：私信轮询期间面板就是开着的（它整段只关一次门）。这种「面板开着」不算需要人工处理，
    // 否则每次私信读消息都会把整轮判死。真卡住了（面板在、但私信没在跑）仍然按原逻辑失败。
    const panelByChat = Boolean(state?.privateChatVisible) && this.chatPolling();
    if (state?.loginRequired || state?.verificationRequired || state?.blocked || state?.unsupportedPage || (state?.privateChatVisible && !panelByChat)) throw failure('抖音页面需要手动处理，已停止自主观看。', 'needs_user');
    if (panelByChat && (!this._panelBusyAt || this.now() - this._panelBusyAt > 10_000)) { this._panelBusyAt = this.now(); this.onEvent({ type: 'watch.panel_busy', message: '私信正在用页面，这次状态读取照常继续。' }); }
    this.onEvent(redact({ type: 'watch.tool', tool: name, result: output }, [this.config.apiKey]));
    return output;
  }
  // 按一下热键 = 暂停，再按一下 = 继续。标记里带脚本 pid，脚本被杀时标记自动失效。
  isHeld() {
    try {
      if (!fs.existsSync(this.holdFile)) return false;
      const record = JSON.parse(fs.readFileSync(this.holdFile, 'utf8'));
      if (!alive(record?.pid)) { fs.unlinkSync(this.holdFile); return false; }
      return true;
    } catch { return false; }
  }
  async waitWhileHeld() {
    if (!this.isHeld()) return;
    this.onEvent({ type: 'watch.hold_wait', message: '已暂停，这一轮停在这里；再按一下继续。' });
    while (this.isHeld()) { this.assertAllowed(); await delay(250); }
  }
  cancel(reason = failure('自主观看已取消。', 'stopped')) { if (this.worker()?.owned) this.abort?.abort(reason); }
  getShareService() {
    if (!this.shareService && this.personaMemory.snapshot) { this.shareService = new AutonomousShare({ controller: this.controller, videoLimits: this.videoLimits, personaMemory: this.personaMemory, stateDir: this.stateDir, source: this.source, now: this.now }); this.ownsShareService = true; }
    return this.shareService;
  }
  shareContext() { return this.getShareService()?.context() ?? { enabled: false, paused: false, dailyRemaining: 0, recipients: [] }; }
  getCommentService() {
    if (!this.commentService && this.personaMemory.snapshot) { this.commentService = new AutonomousComments({ controller: this.controller, videoLimits: this.videoLimits, personaMemory: this.personaMemory, stateDir: this.stateDir, source: this.source, now: this.now }); this.ownsCommentService = true; }
    return this.commentService;
  }
  getReplyService() {
    if (!this.replyService && this.personaMemory.snapshot) {
      this.replyService = new ReplyService({
        videoLimits: this.videoLimits, stateDir: this.stateDir, source: this.source, now: this.now,
        generate: ({ signal, decisionProvider, ...rest }) => this.replyAgent.generate({ ...rest, decisionProvider: decisionProvider || this.decisionProvider, signal }),
      });
      this.ownsReplyService = true;
    }
    return this.replyService;
  }
  commentContext() { return this.getCommentService()?.context() ?? { enabled: false, paused: false }; }
  // 2026-10-26 20:10 主人定：观看过程中私信要能一直用页面——私信面板被占用时，人格学习样本跳过即可，
  // 不能像 18:40:38 那样把整轮判死（persona-memory 要求 privateChatVisible === false，面板一开就抛）。
  panelBusySkip(error) {
    const message = String((error && error.message) || error);
    if (!/人格学习需要真实可播放作品状态/.test(message)) return false;
    const now = this.now();
    if (!this._panelSkipAt || now - this._panelSkipAt > 10000) {
      this._panelSkipAt = now;
      this.onEvent({ type: 'watch.learning_skipped', message: '私信面板占着页面，这次观看样本没计入学习；观看继续。' });
    }
    return true;
  }
  viewing(evidenceId, from, to, startedAt, sampleId) {
    if (!this.personaMemory.recordViewing) return null;
    try { return this.personaMemory.recordViewing({ evidenceId, from: (from && from.state) || from, to: (to && to.state) || to, wallSeconds: (this.now() - startedAt) / 1000, sampleId }, { source: this.source }); }
    catch (error) { if (this.panelBusySkip(error)) return null; throw error; }
  }
  behavior(evidenceId, action, operationId) {
    try { return this.personaMemory.recordBehavior && this.personaMemory.recordBehavior({ evidenceId, action, confirmed: true, sampleId: 'watch:' + this.runId + ':' + action + ':' + randomUUID(), ...(operationId ? { operationId } : {}) }, { source: this.source }); }
    catch (error) { if (this.panelBusySkip(error)) return null; throw error; }
  }
  leftSeconds(video) {
    return Number.isFinite(video?.duration) && Number.isFinite(video?.time) ? Math.floor(video.duration - video.time) : null;
  }
  // 每跳过/看完一条作品，就把这一条写进共享日记。正文优先用模型这一轮给的 diary，
  // 没给就退回 reason + reflection；`- 看过：` 那行用宿主实际核对到的时长、进度和去留。
  async noteVideo(state) {
    const video = (state.state || state).video;
    if (!video?.id || !/^\d{10,30}$/.test(video.id)) return null;
    if (this.track?.id === video.id) return this.track;
    await this.flushDiary({ position: this.track?.position });
    this.track = { id: video.id, title: video.title, duration: video.duration, position: video.time, startedAt: Number.isFinite(video.time) ? video.time : 0, stayed: false, diary: '', say: '', reason: '', reflection: '', written: false };
    return this.track;
  }
  // 2026-10-23：每一轮到底问了什么、她选了什么、当时评论是开还是关——以前只看得到最后一次决策，
  // 排查「看完了却没评」时全靠猜。落一份追加日志，免得再靠推断。
  logDecision(entry) {
    try { fs.appendFileSync(path.join(path.dirname(this.files.state), 'watch-decisions.jsonl'), JSON.stringify({ at: new Date(this.now()).toISOString(), runId: this.runId, ...entry }) + '\n'); } catch { /* 记不上不影响观看 */ }
  }
  noteDecision(decision, state) {
    const track = this.track;
    if (!track || track.id !== state.video?.id) return;
    if (Number.isFinite(state.video.time)) track.position = state.video.time;
    if (decision.diary) track.diary = decision.diary;
    if (decision.say) track.say = decision.say;
    if (decision.private) track.private = decision.private;
    track.reason = decision.reason;
    track.reflection = decision.reflection;
    if (decision.action === 'stay') track.stayed = true;
  }
  // 离开一条时，如果真看了一会儿，就单独问一次“看完之后的感想”再写；快划的用决策时的话就够。
  diaryFacts(track, { finalPosition, watched, ended, action, endMode }) {
    const clock = (s) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    const duration = Number.isFinite(track.duration) && track.duration > 0 ? clock(track.duration) : '未知';
    const start = Number.isFinite(track.startedAt) ? clock(track.startedAt) : '0:00';
    const end = Number.isFinite(finalPosition) ? clock(finalPosition) : start;
    return [
      `作品：${track.title || '未读到标题'}`,
      `时长：${duration}`,
      `这一轮从 ${start} 看到 ${end}（约 ${Math.round(watched)} 秒）`,
      // 2026-10-25：原来只会写「轮次到点停下」，手动停也这么说，账就撒了谎。
      // 现在由收尾处按 status 传 endMode：划走/看到结尾/轮次到点/主人手动停止/异常中断。
      `离开方式：${action === '划' ? '划走' : ended ? '看到结尾' : (endMode || '停在这里')}`,
      `最后一次判断的理由：${track.reason || '（没有）'}`,
      `最后一次判断的反思：${track.reflection || '（没有）'}`,
      // 2026-10-25：原来写死「没有音频」，可这一轮有滚动转写和音频测量，模型就跟着在日记里写「也没有音频」。
      this._hadAudioFor === track.id
        ? '画面采样只有静帧；声音只有转写和机器测量，你并没有亲耳听过。'
        : '画面采样只有静帧，没有音频。',
    ].join('\n');
  }
  // 日记写没写要能自己核对：每写一条就记账，`douyin_watch_status` 里能直接看到，
  // 不用等人发现「怎么没记录」。written 是成功条数，skipped 是没有正文或视频编号无效。
  async flushDiary({ action, ended = false, position, endMode, track = this.track } = {}) {
    if (!track || track.written) return;
    track.written = true;
    const finalPosition = Number.isFinite(position) ? position : track.position;
    const watched = Math.max(0, finalPosition - (Number.isFinite(track.startedAt) ? track.startedAt : 0));
    // 2026-10-28 主人定：日记只记「看了哪条视频」，不再让模型回写感想、没有「想对你说」，
    // 也不为它花一次请求。
    if (false && track.stayed && watched >= WATCH_PACING.diaryMinSeconds) {
      try {
        const final = await this.agent.writeFinalDiary({ facts: this.diaryFacts(track, { finalPosition, watched, ended, action: action || (track.stayed ? '停' : '划'), endMode }), decisionProvider: this.decisionProvider });
        if (final?.diary) track.diary = final.diary;
        if (final?.say) track.say = final.say;
        if (final?.usage) { this.lastDiaryUsage = final.usage; this.diaryStats.rewriteCalls += 1; this.diaryStats.rewriteTokens += final.usage.totalTokens || 0; }
      } catch (error) { this.onEvent({ type: 'watch.diary_rewrite_failed', message: error.message || String(error) }); }
    }
    // 私人那本写不写是人格自己的判断：模型给了 private 才写，没给就跳过。
    if (false && track.private) {
      try { if (appendPrivateEntry({ at: this.now(), body: track.private })) this.diaryStats.privateWritten += 1; }
      catch (error) { this.onEvent({ type: 'watch.diary_failed', message: error.message || String(error) }); }
    }
    // local add: 看过 60 秒以上，顺手把这一条的音轨拼起来做一次音乐分析（约 5 秒 CPU，不花 token）。
    let audio = '';
    if (this.rollingOn && watched >= 60) {
      try { audio = await this.analyzeAudio(watched); } catch { audio = ''; }
    }
    const body = '';
    try {
      const entry = appendWatchEntry({ at: this.now(), title: track.title, videoId: track.id, duration: track.duration, position: finalPosition, ended, action: action || (track.stayed ? '停' : '划'), body, say: track.say });
      if (entry) { this.diaryStats.written += 1; this.diaryStats.lastAt = new Date(this.now()).toISOString(); this.diaryStats.lastVideoId = track.id; }
      else this.diaryStats.skipped += 1;
    } catch (error) { this.diaryStats.failed += 1; this.onEvent({ type: 'watch.diary_failed', message: error.message || String(error) }); }
    this.saveDiaryStats();
  }
  /**
   * 2026-10-24（主人定 A 方案）：日记回写排进队列，先把"要不要评论"的机会交回去。
   * track 必须在入队时快照下来——this.track 会随换片换掉。
   */
  deferDiary(args = {}) {
    const track = this.track;
    this.diaryChain = (this.diaryChain || Promise.resolve())
      .then(async () => {
        // 2026-10-24（主人定）：有作品正等着「要不要评论」的判断时，回写先让路——
        // 两者抢同一个模型，实测会把"看完→发评论"拖到近 60 秒。
        const until = this.now() + 90_000;
        while (this._finished && !this._diaryStopWait && this.now() < until) {
          try { await this.delayImpl(300, this.abort?.signal); } catch { break; }
        }
        return this.flushDiary({ ...args, track });
      })
      .catch(error => { this.onEvent({ type: 'watch.diary_failed', message: error.message || String(error) }); });
    return this.diaryChain;
  }
  saveDiaryStats() {
    // 单独写一个文件：原来走 this.save() 会刷新 watch-state.json 的 updatedAt，
    // 记账器会把「同一份 usage」再记一条，token 账就重复了。
    try { write(this.diaryStatsFile, { ...this.diaryStats }); } catch (error) { this.onEvent({ type: 'watch.diary_failed', message: error.message || String(error) }); }
  }
  // 12 秒以内的短片等不到模型回答就自己播完了：宿主等到结尾前补一条“正在播”的观看回执，
  // 播完换下一条。不花模型请求，也不会把这类短片算成 skip。
  async watchShort({ evidenceId, observedState, current, sampleStartedAt }) {
    const video = observedState.video;
    const left = Number.isFinite(video.duration) && Number.isFinite(video.time) ? video.duration - video.time : 0;
    const roundLeft = Math.max(0, this.videoLimits.state().remainingSeconds - 1);
    if (left > 1.2 && roundLeft > 1) await this.delayImpl(Math.min(left - 0.6, roundLeft) * 1000, this.abort.signal);
    this.assertAllowed();
    let next = await this.execute('douyin_status'), after = next.state || next;
    if (after.video?.id === video.id && after.video.paused === false && after.video.time > video.time) {
      const stayed = this.viewing(evidenceId, current, next, sampleStartedAt, `watch:${this.runId}:short-view:${randomUUID()}`);
      if (stayed?.accepted === true) this.behavior(evidenceId, 'stay');
    }
    await this.delayImpl(1000, this.abort.signal); this.assertAllowed();
    next = await this.execute('douyin_status'); after = next.state || next;
    if (after.video?.id === video.id) next = await this.execute('douyin_next');
    return next;
  }
  /** 记下这条作品看到过的最高进度：用来判断"它其实已经到过结尾、现在只是被重播"。 */
  noteProgress(video) {
    const id = video?.id, pos = Number(video?.time);
    if (!id || !Number.isFinite(pos)) return;
    if (!this._maxPos) this._maxPos = {};
    if (!(this._maxPos[id] >= pos)) this._maxPos[id] = pos;
  }
  /** 这条是不是"已经到过结尾"（含 80% 长片规则）。 */
  seenEnd(video) {
    const d = Number(video?.duration), pos = Number(video?.time);
    if (!video?.id || !Number.isFinite(d) || d <= 0) return false;
    const max = Math.max(Number(pos) || 0, Number(this._maxPos?.[video.id]) || 0);
    if (this.enoughWatched({ ...video, time: max })) return true;
    return max >= d - 2;
  }
  /** 长片看够 80% 就算看完（只有 >3 分钟的作品走这条，短视频仍要到结尾）。 */
  enoughWatched(video) {
    const d = Number(video?.duration), pos = Number(video?.time);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(pos)) return false;
    return d > LONG_VIDEO.minDuration && pos >= d * LONG_VIDEO.ratio;
  }
  // local add: 额外感兴趣的作品采样更密。决策里 topics 出现 signal:'like' 就当“额外感兴趣”，
  // 这条作品的连看采样从 20 秒缩到 5 秒；换下一条时在 run() 里清掉，自动回到 20 秒。
  applyPacing(decision, video) {
    const id = video?.id;
    if (!id) return;
    // 2026-10-27 主人定：收紧——3–9 秒只是“再确认”，不能凭一次短停留标 like；至少 10 秒的 stay 才算。
    const hot = decision?.action === 'stay' && Number.isFinite(decision.seconds) && decision.seconds >= 10 && Array.isArray(decision.topics) && decision.topics.some(item => item?.signal === 'like');
    if (!hot || this._hotVideoId === id) return;
    this._hotVideoId = id;
    this.save({ pacing: { videoId: id, chunkSeconds: WATCH_PACING.hotChunkSeconds, observeSeconds: WATCH_LIMITS.hotObserveSeconds, staySeconds: WATCH_PACING.hotStaySeconds, reason: '这条作品被标了 like' } });
    this.onEvent({ type: 'watch.pacing', message: `这条标了 like，连看补帧缩到 ${WATCH_PACING.hotChunkSeconds} 秒，观察窗口放慢到 5 秒一张，连看封顶 ${WATCH_PACING.hotStaySeconds} 秒。` });
  }
  // 模型说继续看以后，宿主自己计时补记回执：每段最多 25 秒（观看回执的墙钟上限是 30 秒）。
  // 10 秒以上的停留才延长到 90 秒；3–9 秒的意思是“再确认一下”，到点就回外层重新采样。
  async watchStay({ evidenceId, decision, current }) {
    let learned = false, total = 0, state = current.state || current;
    // 这条作品如果被标了 like，连看补帧 5 秒一张；否则还是 20 秒（2026-10-22 主人定）。
    const hot = Boolean(this._hotVideoId) && this._hotVideoId === state.video?.id;
    const chunkSeconds = hot ? WATCH_PACING.hotChunkSeconds : WATCH_PACING.chunkSeconds;
    const firstSeconds = hot ? Math.min(decision.seconds, chunkSeconds) : decision.seconds;
    let seconds = Math.max(1, Math.min(firstSeconds, this.leftSeconds(state.video) ?? decision.seconds, Math.max(1, this.videoLimits.state().remainingSeconds)));
    const baseCap = decision.seconds >= 20 ? WATCH_PACING.deepSeconds : decision.seconds >= 10 ? WATCH_PACING.mildSeconds : decision.seconds;
    // 喜欢后单独封顶 20 秒：6 格刚好 5/10/15/20/25/30，不留 10 秒空档。
    const cap = hot ? Math.min(baseCap, WATCH_PACING.hotStaySeconds) : baseCap;
    // 2026-10-27：留一条 stay_plan，下一轮核对 hot 是否真的在这一段生效（首帧位置对不上时靠它）。
    this.logDecision({ action: 'stay_plan', videoId: state.video?.id ?? null, hot, chunkSeconds, firstSeconds, seconds, cap, stateTime: state.video?.time ?? null });
    if (this.track?.id === state.video?.id && Number.isFinite(state.video.time)) this.track.position = state.video.time;
    try {
    while (true) {
      const startedAt = this.now();
      // 连看期间有 20 秒音频就先在后台算（不等它），这样下一次决策直接读得到，不用再花 5 秒等；
      // 45 秒内不重复，所以这里只是个"提前预热"，决策前的 await 仍是兜底。
      if (startedAt - (this._videoSince || startedAt) >= 20_000) void this.refreshAudio(state.video?.id, (this._videoSince || startedAt) - 5_000);
      await this.delayImpl(seconds * 1000, this.abort.signal); this.assertAllowed();
      const next = await this.execute('douyin_status');
      const after = next.state || next;
      total += seconds;
      // 这一段到底有没有播到结尾：用「段起点 + 这一段的秒数」估，别把中途被换掉的片子写成「看完」。
      const reachedEnd = Number.isFinite(state.video.duration) && state.video.duration > 0 && Number.isFinite(state.video.time) && state.video.time + seconds >= state.video.duration - 1;
      // 抖音播完可能不暂停、直接从 0 重播（同一个 id）。进度大幅倒退就当「这条看完了」：
      // 写日记、换下一条，否则会在同一集里一直空转（实测 10 分钟把 6:57 的片子看了两遍）。
      if (after.video?.id === state.video.id && Number.isFinite(after.video.time) && Number.isFinite(state.video.time) && after.video.time < state.video.time - 1) {
        this.onEvent({ type: 'watch.finished', message: reachedEnd ? '作品播完从头重播，停住等一次判断。' : '进度退回开头，停住等一次判断。' });
        this.deferDiary({ action: '停', ended: reachedEnd, position: state.video.time, endMode: '进度回到开头（平台重播）' });
        try { this.viewing(evidenceId, state, next, startedAt, `watch:${this.runId}:stay-view:${randomUUID()}`); } catch { /* 重播样本不计入学习 */ }
        // A 方案（2026-10-22 主人定）：看完先停住，回外层问一句“要不要留评论”，不立刻换片。
        // 2026-10-24 修：这里原来会 douyin_play「继续播」，短片一 play 就从头重播，
        // 下一轮决策把它当新视频又看一遍 —— 实测 14 秒的片子连放三遍、闪白一串。现在停在结尾不动。
        return { current: await this.execute('douyin_status'), learned, finished: true };
      }
      if (after.video?.id !== state.video.id) {
        // 看到结尾、平台自己切了下一条：算正常看完，接着看新的这条，不要判失败。
        this.onEvent({ type: 'watch.finished', message: reachedEnd ? '当前作品看到结尾，平台自动切到下一条。' : '播放途中换到了下一条。' });
        this.deferDiary({ action: '停', ended: reachedEnd, position: state.video.time, endMode: '平台换到下一条' });
        try { this.viewing(evidenceId, state, next, startedAt, `watch:${this.runId}:stay-view:${randomUUID()}`); } catch { /* 作品已换，这次停留不写回执 */ }
        // 2026-10-23：平台播完自动切片时，日记写了「看完」但这条分支没把评论机会交回去，
        // 于是 4 条「看完」全被吞掉、一次评论决策都没问过。看到结尾就照样停住等判断，并记下是哪一条。
        if (reachedEnd) {
          // 同上：不再 play，免得从头重播又被当成新视频。
          return { current: await this.execute('douyin_status'), learned, finished: true, finishedVideoId: state.video.id };
        }
        return { current: next, learned };
      }
      // 日记里「看到哪」要用最后的真实进度，轮次到点时也按这个写。
      if (this.track?.id === after.video?.id && Number.isFinite(after.video.time)) this.track.position = after.video.time;
      this.noteProgress(after.video);
      if (after.video?.id === state.video.id && this.enoughWatched(after.video)) {
        this.onEvent({ type: 'watch.finished', message: '长片已看到 80%，按看完处理，停住等一次判断。' });
        // 日记要诚实：80% 是「停」，不是「看完」——只有评论闸门把它当看完。
        this.deferDiary({ action: '停', ended: false, position: after.video.time, endMode: '看到八成停下（长片按 80% 算看过）' });
        try { this.viewing(evidenceId, state, next, startedAt, `watch:${this.runId}:stay-view:${randomUUID()}`); } catch { /* 80% 样本不做学习 */ }
        return { current: next, learned, finished: true };
      }
      if (after.video?.paused !== false) {
        const video = after.video;
        const atEnd = Number.isFinite(video?.duration) && Number.isFinite(video?.time) && video.duration > 0 && video.time >= video.duration - 1.5;
        // 热键暂停不是异常：等松开后回外层重新采样，别把这一轮判死。
        if (this.isHeld()) { await this.waitWhileHeld(); return { current: next, learned }; }
        if (!atEnd) {
          // 同上一处：外部弹层（私信/回复）会把视频暂停，先尝试恢复一次。
          let resumed = false;
          try {
            const played = await this.execute('douyin_play');
            const state = played.state || played;
            resumed = state.video?.paused === false && state.video?.id === video.id;
          } catch { /* 恢复不了再判失败 */ }
          if (resumed) { this.onEvent({ type: 'watch.resumed', message: '作品被外部暂停，已恢复播放。' }); return { current: await this.execute('douyin_status'), learned }; }
          throw failure('停留期间作品被暂停，已停止自主观看，没有学习本次停留。', 'needs_user');
        }
        // 播到结尾停住了：抖音在末尾会暂停而不是自动切。A 方案下不直接换片，
        // 先停在这里回外层，让她决定要不要给这条留一句评论（评论只对看完的作品）。
        this.onEvent({ type: 'watch.finished', message: '作品播到结尾，停住等一次判断。' });
        this.deferDiary({ action: '停', ended: true });
        try { this.viewing(evidenceId, state, next, startedAt, `watch:${this.runId}:stay-view:${randomUUID()}`); } catch { /* 结尾样本不做学习 */ }
        // 2026-10-27：先补拍结尾那一帧存起来。抖音播完会立刻回到 0 秒重播，
        // 外层观察可能只能抓到重播开头；评论前的 C 用这张结尾帧，而不是开头。
        try {
          const shot = await this.controller.capture(0, this.abort.signal, { recordLearning: false, recordEvidence: false });
          const frame = shot?.frames?.[0];
          if (frame && frame.videoId === video.id) this._lastEndFrame = frame;
        } catch { /* 拍不到就用外层观察帧 */ }
        return { current: next, learned, finished: true };
      }
      const stayed = this.viewing(evidenceId, state, next, startedAt, `watch:${this.runId}:stay-view:${randomUUID()}`);
      if (stayed?.accepted === true && this.behavior(evidenceId, 'stay')?.accepted === true) learned = true;
      // local add: 连看期间也持续采样。以前整段 2/5 分钟只有开头 3 帧，中段完全没画面；
      // 现在每段补一张（默认 20 秒，标了 like 的作品 5 秒），下一轮决策会带上其中一张，屏幕也会跟着持续闪。
      // 注意：不能走 execute()——它会先查 TOOL_DEFINITIONS，不在表里的名字直接 reject
      // （2026-10-22 实测：加了 douyin_grab_frame 却没登记，凭 catch 静默失败，闪白一张都没多）。
      const leftInVideo = this.leftSeconds(after.video) ?? 0;
      const leftInRound = Math.max(0, this.videoLimits.state().remainingSeconds - 1);
      const lastChunk = cap - total < 1 || leftInVideo <= 1 || leftInRound < 1;
      // 2026-10-27：最后一段不补中段帧。紧接着的观察第一张就是同一时刻（26 秒），
      // 再补一张 26 秒会让拼图出现两格几乎一样的画面，B 从 5 格变 4 格。
      if (!lastChunk) {
        try {
          const shot = await this.controller.capture(0, this.abort.signal, { recordLearning: false, recordEvidence: false });
          const frame = shot?.frames?.[0];
          // 喜欢的作品留 8 张（5 秒一张 ≈ 40 秒跨度），这样下一轮可以拿最早和最新两张对比，看出画面有没有在动；
          // 普通作品只留最近 3 张。
          const keep = hot ? 8 : 3;
          if (frame && frame.videoId === after.video?.id) this._stayFrames = [...(this._stayFrames || []).slice(-keep), frame];
        } catch { /* 截不到不影响观看，下一段再试 */ }
      }
      if (lastChunk) {
        // 2026-10-26：正好停在结尾（剩不到 1 秒）以前当成普通「继续」，于是播完重播也不给评论机会。
        const atEnd = Number.isFinite(after.video?.duration) && Number.isFinite(after.video?.time) && after.video.duration > 0 && after.video.time >= after.video.duration - 2;
        if (atEnd) {
          this.onEvent({ type: 'watch.finished', message: '连看到结尾，停住等一次判断。' });
          this.deferDiary({ action: '停', ended: true });
          // 2026-10-28：抖音播完常常不暂停、直接回 0 秒重播，而这条「最后一段正好到结尾」的分支
          // 以前不补拍结尾帧，评论前的 C 拿到的「结尾」其实是重播开头（实测 0.8/10.9 秒）。
          try {
            const shot = await this.controller.capture(0, this.abort.signal, { recordLearning: false, recordEvidence: false });
            const frame = shot?.frames?.[0];
            if (frame && frame.videoId === after.video?.id) this._lastEndFrame = frame;
          } catch { /* 拍不到就用外层观察帧 */ }
          return { current: next, learned, finished: true };
        }
        this.onEvent({ type: 'watch.continue', message: `这条已连看 ${total} 秒，重新采样后再判断。` });
        return { current: next, learned };
      }
      state = after;
      seconds = Math.max(1, Math.floor(Math.min(chunkSeconds, cap - total, leftInVideo, leftInRound)));
    }
    } finally {
      this.logDecision({ action: 'stay_end', videoId: this.track?.id ?? state.video?.id ?? null, hot, cap, total, frames: (this._stayFrames || []).slice(-8).map(frame => Number.isFinite(frame.time) ? Math.round(frame.time * 10) / 10 : null) });
    }
  }
  // 2026-10-28 主人定：采样那 6 张就决定看不看；决定看之后不再逐次决策，
  // 宿主自己每 10 秒补一张拼图，一口气看到结尾，再把整条时间线交给「评论」那一次调用。
  async composeAndStore(observation) {
    if (!WATCH_COMPOSITE.enabled) return null;
    const state = observation.state || observation;
    const video = state.video;
    const frames = Array.isArray(observation.frames) ? observation.frames : [];
    if (!video?.id || frames.length < 2) return null;
    const compositeFrames = dedupeFramesByTime(frames, 1.2).slice(-WATCH_COMPOSITE.maxFrames);
    if (compositeFrames.length < 2) return null;
    const columns = compositeFrames.length === 4 ? 2 : WATCH_COMPOSITE.columns;
    try {
      const composite = await this.controller.composeFrames(compositeFrames, { columns, cellHeight: WATCH_COMPOSITE.cellHeight, cropRightPx: WATCH_COMPOSITE.cropRightPx, cropBottomPx: WATCH_COMPOSITE.cropBottomPx, signal: this.abort.signal });
      const times = compositeFrames.map((frame) => (Number.isFinite(frame.time) ? Math.round(frame.time * 10) / 10 : null));
      this.logDecision({ action: 'composite', videoId: video.id, kind: 'observe', videoAt: video.time ?? null, frames: times, dropped: frames.length - compositeFrames.length, width: composite.width, height: composite.height, crop: composite.crop, bytes: composite.bytes });
      if (this._storyboard?.videoId !== video.id) this._storyboard = { videoId: video.id, composites: [] };
      this._storyboard.composites.push({ ...composite, kind: 'observe', times });
      try { this._captureSession?.addFrames({ videoId: video.id, times }); } catch { /* 会话记不上不影响观看 */ }
      const max = WATCH_COMPOSITE.storyboardMax;
      if (this._storyboard.composites.length > max) {
        const samplingComposite = this._storyboard.composites.find((item) => item.kind === 'sampling');
        const rest = this._storyboard.composites.filter((item) => item !== samplingComposite).slice(-(max - (samplingComposite ? 1 : 0)));
        this._storyboard.composites = samplingComposite ? [samplingComposite, ...rest] : rest;
      }
      return composite;
    } catch (error) {
      this.onEvent({ type: 'watch.compose_failed', message: '拼图没生成：' + String(error?.message || error).slice(0, 100) });
      return null;
    }
  }
  // 2026-10-29：评论前准备「整条视频的抽帧故事板 + 高赞弹幕」。哪一个失败都不拦着评论。
  async prepareCommentMedia(videoId, duration) {
    const media = { sheets: [], danmaku: '', transcript: '', detail: {} };
    try {
      const composed = await this.controller.composeStoryboard(videoId, { duration, maxSheets: WATCH_STORYBOARD.maxSheets, signal: this.abort?.signal });
      media.sheets = (composed.sheets || []).map((sheet) => ({ mimeType: sheet.mimeType, data: sheet.data, times: sheet.times, file: sheet.file }));
      media.detail.storyboard = { sheets: media.sheets.length, cells: composed.cells, frames: composed.frames };
      this.logDecision({ action: 'storyboard', videoId, sheets: media.sheets.length, cells: composed.cells, dropped: composed.dropped || 0, frames: composed.frames, times: composed.times });
    } catch (error) {
      this.logDecision({ action: 'storyboard_failed', videoId, reason: String(error?.message || error).slice(0, 90) });
    }
    try {
      const danmaku = await this.controller.danmakuFor(videoId, { limit: 20, duration });
      media.danmaku = danmaku.text || '';
      media.detail.danmaku = { total: danmaku.total, picked: danmaku.picks?.length || 0, source: danmaku.source };
      // 这一条作品的整条转写（每行是 [mm:ss-mm:ss] 窗口 + 文本），评论和落盘都用它。
      media.transcript = fullTranscript({ maxChars: 2400 }) || '';
      this.logDecision({ action: 'danmaku', videoId, total: danmaku.total, picked: danmaku.picks?.length || 0, source: danmaku.source });
    } catch (error) {
      this.logDecision({ action: 'danmaku_failed', videoId, reason: String(error?.message || error).slice(0, 90) });
    }
    return media;
  }
  async watchToEnd({ evidenceId, current }) {
    let state = current.state || current;
    const id = state.video?.id;
    if (!id) return { current, learned: false, finished: true };
    for (let step = 0; step < 360; step++) {
      this.assertAllowed();
      const before = state.video || {};
      const left = Number.isFinite(before.duration) ? before.duration - (before.time || 0) : NaN;
      const seconds = Number.isFinite(left) ? Math.max(1, Math.min(WATCH_LIMITS.observeSeconds, left + 1)) : WATCH_LIMITS.observeSeconds;
      const observation = await this.execute('douyin_observe', { seconds });
      const after = observation.state || observation;
      if (after.video?.id && after.video.id !== id) return { current: after, learned: false, finished: true };
      if (this.track?.id === id && Number.isFinite(after.video?.time)) this.track.position = after.video.time;
      this.noteProgress(after.video);
      // 2026-10-28：容差从 1.5 秒放到 3 秒——留 1.5 秒时实测 56.9/58.8 差 1.9 秒，没进这个分支，
      // 等下一段观察时视频已经重播，补拍的「结尾帧」其实是 3.1 秒的开头。
      const atEnd = Number.isFinite(after.video?.duration) && Number.isFinite(after.video?.time) && after.video.duration > 0 && after.video.time >= after.video.duration - 3;
      const rolled = Number.isFinite(after.video?.time) && Number.isFinite(before.time) && after.video.time < before.time - 1;
      // 中途被外部暂停（私信弹层、切窗口）不算看完：先恢复一次，恢复不了再当异常结束。
      if (!atEnd && !rolled && after.video?.paused === true) {
        let resumed = false;
        try {
          const played = await this.execute('douyin_play');
          const state = played.state || played;
          resumed = state.video?.paused === false && state.video?.id === id;
        } catch { /* 恢复不了就走下面的收尾 */ }
        if (!resumed) return { current: after, learned: false, finished: true };
        state = state;
        continue;
      }
      if (atEnd || rolled) {
        // 2026-10-28：抖音播完常常直接回 0 秒重播，先把结尾那一帧补拍下来，评论前的 C 才有真结尾。
        try {
          const shot = await this.controller.capture(0, this.abort.signal, { recordLearning: false, recordEvidence: false });
          const frame = shot?.frames?.[0];
          if (frame && frame.videoId === id) this._lastEndFrame = frame;
        } catch { /* 拍不到就用外层观察帧 */ }
        this.deferDiary({ action: '停', ended: atEnd, position: after.video?.time, endMode: atEnd ? '看到结尾' : '进度回到开头（平台重播）' });
        return { current: after, learned: false, finished: true };
      }
      await this.composeAndStore(observation);
      if (this.enoughWatched(after.video)) {
        this.deferDiary({ action: '停', ended: false, position: after.video?.time, endMode: '看到八成停下（长片按 80% 算看过）' });
        return { current: after, learned: false, finished: true };
      }
      state = after;
    }
    return { current: state, learned: false, finished: true };
  }
  // local add: 轮次开始时拉起“滚动转写”（采集 + 常驻转写两个子进程），结束时收掉。
  // 目录固定在 state\rolling，api-agent 的 prompts 从那里取最近台词；起不来就安静跳过。
  startRolling() {
    try {
      const root = process.env.DOUYIN_ROLL_ROOT || 'D:\\Deep\\tools\\sensevoice';
      const captureScript = path.join(root, 'roll_capture.mjs');
      const workerScript = path.join(root, 'roll_worker.py');
      const pythonExe = process.env.DOUYIN_ROLL_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
      const nodeExe = process.env.DOUYIN_ROLL_NODE || 'C:\\Users\\叶灼\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe';
      if (!fs.existsSync(captureScript) || !fs.existsSync(workerScript) || !fs.existsSync(pythonExe) || !fs.existsSync(nodeExe)) {
        this.onEvent({ type: 'watch.rolling_skipped', message: '没装滚动转写（tools\\sensevoice 缺文件），这次不带台词。' });
        return null;
      }
      const directory = path.join(resolveRuntimePaths().stateDir, 'rolling');
      fs.mkdirSync(directory, { recursive: true });
      // 采集端的段编号每轮都从 0000 重来，而 .done 标记是永久留下的：
      // 不清掉的话，这一轮前几十段会被转写端当成“已经转过”直接跳过（2026-10-22 21:40 查清）。
      for (const name of fs.readdirSync(directory)) {
        if (/^seg-\d+\.(webm|done)$/.test(name) || name === 'segments.jsonl' || name === 'audio.json') {
          try { fs.unlinkSync(path.join(directory, name)); } catch { /* 被占着就跳过这只 */ }
        }
      }
      fs.writeFileSync(path.join(directory, 'rolling.txt'), '');
      // 转写端的输出以前是 stdio:'ignore'，出问题什么都看不到；改成落 worker.log。
      // 不带 PYTHONUTF8 的话 Python 按 cp936 往日志写，中文会糊成乱码（rolling.txt 本身是 utf-8，不受影响）。
      let workerOut = 'ignore';
      try { workerOut = fs.openSync(path.join(directory, 'worker.log'), 'a'); } catch { /* 开不了就还按忽略 */ }
      const worker = spawn(pythonExe, [workerScript, directory, '--idle', '300'], { windowsHide: true, stdio: ['ignore', workerOut, workerOut], env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
      const capture = spawn(nodeExe, [captureScript, directory, '3600', '10', '9227'], { windowsHide: true, stdio: 'ignore' });
      for (const child of [worker, capture]) child.on('error', () => {});
      this.onEvent({ type: 'watch.rolling_started', message: '滚动转写已启动（每 10 秒一段，转写时垫上一段最后 2 秒）。' });
      return { worker, capture, directory, kill: () => { for (const child of [capture, worker]) { try { child.kill(); } catch { /* 已经退了 */ } } } };
    } catch (error) {
      this.onEvent({ type: 'watch.rolling_failed', message: `滚动转写没起来：${error.message}` });
      return null;
    }
  }

  // local add: 看完一条（≥60 秒）时，把这一条采到的音轨拼起来跑一次音乐分析，
  // 结果作为一行「音频：…」写进日记。分析失败、没装引擎就安静跳过。
  async analyzeAudio(watched) {
    return await new Promise(resolve => {
      try {
        const root = process.env.DOUYIN_ROLL_ROOT || 'D:\\Deep\\tools\\sensevoice';
        const script = path.join(root, 'audio_report.py');
        const python = process.env.DOUYIN_ROLL_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
        if (!fs.existsSync(script) || !fs.existsSync(python)) return resolve('');
        const directory = path.join(resolveRuntimePaths().stateDir, 'rolling');
        const since = String(Math.round(this.now() - (watched + 20) * 1000));
        const child = spawn(python, [script, directory, '--since', since], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          // 不设这两个变量，Python 会按控制台编码（cp936）往 stdout 写，Node 再按 utf8 解，中文就成乱码了。
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        });
        let out = '';
        const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } }, 25_000);
        child.stdout?.on('data', chunk => { out += chunk.toString('utf8'); });
        child.on('error', () => { clearTimeout(timer); resolve(''); });
        child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
      } catch { resolve(''); }
    });
  }

  // local add: 给这一条算一次音频判断，写进 state\rolling\audio.json，
  // 决策会随 payload 的 audio 字段一起给模型——她听不到声音，但至少能分出这是歌、是讲解还是没有声音。
  // 返回一个 Promise（拿到那一行或空串），调用方可以 await（决策前）或不管（连看期间）。
  // 同一部作品 45 秒内不重复算。
  refreshAudio(videoId, since) {
    try {
      if (!videoId || !Number.isFinite(since)) return Promise.resolve('');
      if (this._audioJob && this._audioJob.videoId === videoId && this.now() - this._audioJob.at < 45_000) return Promise.resolve('');
      const root = process.env.DOUYIN_ROLL_ROOT || 'D:\\Deep\\tools\\sensevoice';
      const script = path.join(root, 'audio_report.py');
      const python = process.env.DOUYIN_ROLL_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
      if (!fs.existsSync(script) || !fs.existsSync(python)) return Promise.resolve('');
      const directory = path.join(resolveRuntimePaths().stateDir, 'rolling');
      this._audioJob = { videoId, at: this.now() };
      const child = spawn(python, [script, directory, '--since', String(Math.round(since))], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      let out = '';
      return new Promise(resolve => {
        const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } }, 25_000);
        child.stdout?.on('data', chunk => { out += chunk.toString('utf8'); });
        child.on('error', () => { clearTimeout(timer); resolve(''); });
        child.on('close', () => {
          clearTimeout(timer);
          const line = out.trim().split('\n').filter(Boolean).pop() || '';
          if (line) {
            // 2026-10-25：这一条确实有声音证据，日记的 facts 别再写死「没有音频」。
            this._hadAudioFor = videoId;
            try {
              fs.writeFileSync(path.join(directory, 'audio.json'), JSON.stringify({ videoId, text: line.slice(0, 140), at: Date.now() }));
            } catch { /* 写不进去就不带音频信息 */ }
          }
          resolve(line);
        });
      });
    } catch { return Promise.resolve(''); }
  }

  async run() {
    let status = 'stopped', lastError = '';
    try {
      // 2026-10-25：第一眼就等私信面板关掉（见 execute 里的注释）。
      this._firstProbe = true;
      let current = await this.execute('douyin_status');
      if (!(current.state || current).video?.id) {
        // local fix 5: 推荐流停在直播页时 douyin_open 会抛「尚未读到就绪视频」，直接换下一条。
        try { current = await this.execute('douyin_open'); }
        catch { current = await this.execute('douyin_next'); }
      }
      this.rolling = this.startRolling();
      try {
        this._captureSession = new CaptureSession({
          dir: path.join(resolveRuntimePaths().stateDir, 'capture-sessions'),
          runId: this.runId,
          segmentsFile: path.join(resolveRuntimePaths().stateDir, 'rolling', 'segments.jsonl'),
        });
      } catch { this._captureSession = null; }
      this.rollingOn = Boolean(this.rolling);
      this._stayFrames = [];
      // A 方案：看完的作品停在这里，等一次「要不要留评论」的判断；换片就清。
      this._finished = null;
      this._maxPos = {};
      // 2026-10-27：这一轮见过的作品 id 和「拼图时间线」。换作品时重置，
      // 第一条永远是开头采样（3 秒、1.5 秒间隔），之后的观察用 5 秒间隔（2026-10-28 起）。
      this._observedVideoId = null;
      this._storyboard = null;
      this._lastEndFrame = null;
      // 新的一轮从 20 秒采样开始：上一轮标的 like 不跨轮。
      this._hotVideoId = null;
      this.save({ pacing: null });
      // 2026-10-30 主人定：开轮时顺手清掉两天前的故事板/拼图，别让 state 目录一直涨。
      try {
        const stateDir = resolveRuntimePaths().stateDir;
        const cleaned = cleanupOldMedia([path.join(stateDir, 'sheets'), path.join(stateDir, 'composites'), path.join(stateDir, 'danmaku')], { maxAgeDays: 2, now: this.now });
        // 录音段只在下一轮开轮时才整目录清；这里补一刀：两天前的残段（含 .done 标记）也丢掉。
        const staleAudio = cleanupOldMedia([path.join(stateDir, 'rolling')], { maxAgeDays: 2, now: this.now, match: /^seg-\d+\.(webm|done)$/ });
        for (const [key, value] of Object.entries(staleAudio.removed)) cleaned.removed['rolling-' + key] = value;
        const total = Object.values(cleaned.removed).reduce((sum, count) => sum + count, 0);
        if (total) this.onEvent({ type: 'watch.cleanup', message: `清了两天前的图片 ${total} 个（${Object.entries(cleaned.removed).map(([k, v]) => k + ' ' + v).join('、')}）。` });
        this.logDecision({ action: 'cleanup', removed: cleaned.removed, kept: cleaned.kept });
      } catch { /* 清理失败不影响这一轮 */ }
      // 2026-10-24 主人定：开轮先看一眼有没有人回复我。每条作品最多回 4 次、同一条回复只回一次，
      // 一轮最多处理 1 条，别把刷视频的时间全花在回评论上；失败不影响这一轮观看。
      try {
        const replies = this.getReplyService();
        if (replies?.state().enabled) {
          const handled = await replies.checkApi({ max: 1, signal: this.abort.signal });
          if (handled.replied.length) this.onEvent({ type: 'watch.replies', message: `回了 ${handled.replied.length} 条评论回复。`, result: handled.replied });
          for (const skip of handled.skipped) this.onEvent({ type: 'watch.replies_skipped', message: skip.reason });
        }
      } catch (error) { this.onEvent({ type: 'watch.replies_error', message: `回复检查跳过：${String(error?.message || error).slice(0, 120)}` }); }
      while (true) {
        this.assertAllowed();
        await this.waitWhileHeld();
        const budget = this.budget();
        if ((budget.days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw failure('今天的自主观看请求预算已用完。', 'limited');
        // 2026-10-24：回复改成页面内 fetch 发（不动 UI、不导航、不暂停视频），所以轮中也能查。
        // 每 20 秒最多一次；没有新回复时只发一次只读请求。
        if (this.now() - (this._replyCheckAt || 0) > 20_000) {
          this._replyCheckAt = this.now();
          try {
            const replyService = this.getReplyService();
            if (replyService?.state().enabled && this.videoLimits.state().allowed) {
              const handled = await replyService.checkApi({ max: 1, signal: this.abort.signal });
              if (handled.replied?.length) this.onEvent({ type: 'watch.replies', message: `回了 ${handled.replied.length} 条评论回复。`, result: handled.replied });
            }
          } catch (error) { this.onEvent({ type: 'watch.replies_error', message: `回复检查跳过：${String(error?.message || error).slice(0, 120)}` }); }
        }
        // 2026-10-28 主人定：广告本地判，直接划走，不花一次模型请求（DOUYIN_AD_SKIP=0 可关）。
        const adState = current.state || current;
        if (process.env.DOUYIN_AD_SKIP !== '0' && adState?.ad === true) {
          this._adStreak = (this._adStreak || 0) + 1;
          this.logDecision({ action: 'ad_skipped', videoId: adState.video?.id ?? null, time: adState.video?.time ?? null });
          this.onEvent({ type: 'watch.ad_skipped', message: '这一条是广告，直接划走（不花模型请求）。' });
          if (this._adStreak > 8) throw failure('连续多条都是广告，先停下。', 'stopped');
          current = await this.execute('douyin_next');
          continue;
        }
        this._adStreak = 0;
        // 看完停住的那一条不要再 play，否则会从头重播、把「看完」的判断冲掉。
        const pausedNow = (current.state || current).video?.paused !== false;
        const holdingFinished = pausedNow && this._finished && this._finished.videoId === (current.state || current).video?.id;
        if (pausedNow && !holdingFinished) current = await this.execute('douyin_play');
        const sampleStartedAt = this.now();
        // 2026-10-27：换到一条没见过的作品时先采样 3 秒（0 / 1.5 / 3 秒三张）；
        // 同一条作品之后的观察统一 10 秒窗口（0 / 5 / 10 秒三张，5 秒间隔）；
        // 2026-10-28 起 like 作品也是同一档，区别只剩连看补帧（5 秒一张、封顶 20 秒）。
        // 采样无论喜欢与否都是 3 秒/1.5 秒，评论用的采样也不改。
        // 这里先用上一次的状态猜，等观察回来再用真实作品 id 校正一次。
        const beforeVideoId = (current.state || current).video?.id;
        const samplingGuess = beforeVideoId !== this._observedVideoId;
        // 2026-10-29：抽帧要在采样**之前**起，否则前 7.5 秒采样的那几秒根本没有帧——
        // 实测 770125 那条 72 秒的作品，故事板第一格是 12.55 秒，开头整段丢了。
        // 这里先用上一条状态里的 id 起，观察回来发现 id 变了才重起（那时才丢几秒）。
        if (samplingGuess && beforeVideoId && WATCH_STORYBOARD.enabled) {
          try { await this.controller.startFrameGrab(beforeVideoId); }
          catch (error) { this.logDecision({ action: 'grab_failed', videoId: beforeVideoId, reason: String(error?.message || error).slice(0, 90) }); }
        }
        const hotGuess = Boolean(this._hotVideoId) && this._hotVideoId === beforeVideoId;
        const observeSeconds = samplingGuess ? WATCH_LIMITS.sampleSeconds : hotGuess ? WATCH_LIMITS.hotObserveSeconds : WATCH_LIMITS.observeSeconds;
        let observation = await this.execute('douyin_observe', samplingGuess ? { seconds: observeSeconds, frames: WATCH_LIMITS.sampleFrames } : { seconds: observeSeconds });
        const observedAt = this.now(), observedState = observation.state || observation;
        this.noteProgress(observedState?.video);
        // local add: 换片时把台词文件清空。滚动转写是跨作品累积的，不清的话新片开头读到的是
        // 上一条的台词（实测 2026-10-22：音乐混剪读到了龙珠的对白，模型自己发现对不上才没用）。
        const currentVideoId = observedState?.video?.id;
        // 2026-10-27：真实作品 id 决定这次是「采样」还是「观察」，也决定拼图时间线归哪条作品。
        const sampling = currentVideoId !== this._observedVideoId;
        this._observedVideoId = currentVideoId || this._observedVideoId;
        if (currentVideoId && this._storyboard?.videoId !== currentVideoId) this._storyboard = { videoId: currentVideoId, composites: [] };
        if (currentVideoId && this._captureSession) { try { this._captureSession.begin({ videoId: currentVideoId, url: observedState?.video?.url ?? null }); } catch { /* 会话记不上不影响观看 */ } }
        // 2026-10-29：新作品开始看的时候在页面里起抽帧（2fps、原尺寸），看完再用这些帧拼故事板。
        // 上面已经按"猜的 id"起过一次；只有猜错（真的换了条作品）才重起，避免把已经抓到的帧丢掉。
        if (currentVideoId && sampling && WATCH_STORYBOARD.enabled && currentVideoId !== beforeVideoId) {
          try { await this.controller.startFrameGrab(currentVideoId); }
          catch (error) { this.logDecision({ action: 'grab_failed', videoId: currentVideoId, reason: String(error?.message || error).slice(0, 90) }); }
        }
        if (currentVideoId && this._lastEndFrame?.videoId !== currentVideoId) this._lastEndFrame = null;
        if (currentVideoId && this._transcriptVideoId !== currentVideoId) {
          this._transcriptVideoId = currentVideoId;
          // 这一条从什么时候开始被看：音频分析按这个起点挑段。
          this._videoSince = this.now();
          this._audioJob = null;
          try { fs.writeFileSync(path.join(resolveRuntimePaths().stateDir, 'rolling', 'rolling.txt'), ''); }
          catch { /* 清不掉只是台词旧一点，不影响观看 */ }
        }
        // 换到下一条作品：把“额外感兴趣”的 5 秒采样收回去，恢复 20 秒；看完停住的那条也算结束。
        if (this._hotVideoId && currentVideoId && this._hotVideoId !== currentVideoId) {
          this._hotVideoId = null;
          this.save({ pacing: null });
        }
        if (this._maxPos && currentVideoId && !this._maxPos[currentVideoId] && Object.keys(this._maxPos).length > 3) this._maxPos = { [currentVideoId]: this._maxPos[currentVideoId] || 0 };
        if (this._finished && currentVideoId && this._finished.videoId !== currentVideoId) this._finished = null;
        // 直播间没有时长、也没有可比的进度：看到「直播中」直接换下一条，不花这一次模型请求。
        if (observedState?.live === true) {
          this._liveStreak = (this._liveStreak || 0) + 1;
          this.onEvent({ type: 'watch.live_skipped', message: '这一页是直播间（直播中），直接换下一条。' });
          if (this._liveStreak > 8) throw failure('连续多条都是直播间，先停下。', 'stopped');
          current = await this.execute('douyin_next');
          continue;
        }
        this._liveStreak = 0;
        // local fix 4: 直播页/读不到 id 的页会让 watchDecisionMessages 直接抛错，把整轮判成 failed。
        // 这里自己先判：没有可核对的作品就换下一条；连续 8 条都不行才收尾。
        const usableId = /^\d{10,30}$/.test(observedState?.video?.id || '');
        const hasFrames = Array.isArray(observation.frames) && observation.frames.length > 0;
        if (!usableId || !hasFrames) {
          this._badPageStreak = (this._badPageStreak || 0) + 1;
          this.onEvent({ type: 'watch.unusable_page', message: '这一页没有可核对的作品（直播/读不到 id），换下一条。' });
          if (this._badPageStreak > 8) throw failure('连续多条都读不到作品，先停下。', 'stopped');
          current = await this.execute('douyin_next');
          continue;
        }
        this._badPageStreak = 0;
        // 两次判断之间同一条作品从头重播（播完不暂停、直接回 0）：算看完，换下一条再采样。
        // 但「看完停住等评论」的那条不算重播，否则会把这次判断机会冲掉。
        // 2026-10-23：原来阈值是 30 秒，只有长片才碰得到；23.8 秒的医院片播完回 0 时只退了 21 秒，
        // 于是"播完"被当成普通换片，评论机会又丢了。改成 3 秒，并且照样停住等一次 comment/skip。
        // 2026-10-24 修死循环：这条已经判过「看完」的话，别再进重播分支——
        // 否则每轮 observe（3 张、1.5 秒一张）后又被判重播 → continue，来回空转，
        // 实测 20 秒内连拍 21 张（主人看到的"每秒闪白"），一直到播放位置追上才停。
        // 2026-10-26：判定没触发时也要留证据，否则只能猜（15:12 那轮循环两遍都没触发）。
        const maxSeen = Math.max(Number(this._maxPos?.[observedState.video.id]) || 0, Number(this.track?.position) || 0);
        if (this._maxPos?.[observedState.video.id] || this.track?.position != null) {
          this.logDecision({ action: 'replay_check', videoId: observedState.video.id, observed: observedState.video.time ?? null, trackPos: this.track?.position ?? null, trackId: this.track?.id ?? null, maxSeen: maxSeen || null, finishedId: this._finished?.videoId ?? null, holding: Boolean(holdingFinished), diff: Number.isFinite(observedState.video.time) ? Math.round((maxSeen - observedState.video.time) * 10) / 10 : null });
        }
        if (!holdingFinished && this._finished?.videoId !== observedState.video.id && this.track?.id === observedState.video.id && Number.isFinite(maxSeen) && Number.isFinite(observedState.video.time) && maxSeen - observedState.video.time > 3) {
          this.onEvent({ type: 'watch.finished', message: '作品播完从头重播，停住等一次判断。' });
          this.deferDiary({ action: '停', ended: true });
          this._finished = { videoId: observedState.video.id };
          // 2026-10-24：这里也别 play —— 播完回 0 再 play 就是从头放第二遍。
          // 也不再 continue：这次观察已经拿到了画面，直接往下走进决策，
          // 少一轮 observe（=少闪 3 下、少 ~4 秒）。
        }
        // local add: 把连看期间补的帧放到这次观察的最前面——两帧里就有一帧来自中段，
        // 而不是原来那种两张只隔 1.5 秒、几乎重复的开头画面。
        // 标了 like 的作品改用**最早**那张（5 秒一张、最多 8 张），让两张画面对得起 20–40 秒的间隔，
        // 这样"画面在不在动"才看得出来；普通作品还是用最新一张。
        const sampleFrames = observation.frames;
        const stayPool = (this._stayFrames || []).filter(frame => frame.videoId === observedState.video.id);
        const hotVideo = Boolean(this._hotVideoId) && this._hotVideoId === observedState.video.id;
        const stayFrame = stayPool.length ? (hotVideo ? stayPool[0] : stayPool[stayPool.length - 1]) : undefined;
        if (stayFrame && Array.isArray(observation.frames) && observation.frames.length) observation = { ...observation, frames: [stayFrame, ...observation.frames] };
        this._stayFrames = [];
        // local add: 这条已经被看了 20 秒以上（够两段音频）就先算好音频判断再发给模型。
        // 40 秒的停留档下，这是 audio 能进「下一次决策」的唯一窗口；算一次约 5 秒，45 秒内不重复。
        if (this._videoSince && this.now() - this._videoSince >= 20_000) {
          try { await this.refreshAudio(observedState.video.id, this._videoSince - 5_000); } catch { /* 算不出来就不带音频 */ }
          this.assertAllowed();
        }
        const decisionMessages = watchDecisionMessages(observation);
        // local add: 留一条“发给模型的内容里到底有没有 audio/transcript”的硬记录，
        // 看 douyin_watch_status.payload 就能核对，不用再靠猜（2026-10-22 22:08 加）。
        try {
          const payloadText = decisionMessages?.[1]?.content?.find(part => part.type === 'text')?.text || '';
          this.save({ payload: { audio: payloadText.includes('"audio":'), transcript: payloadText.includes('"transcript":'), videoId: observedState?.video?.id || null, at: new Date(this.now()).toISOString() } });
        } catch { /* 记不上不影响观看 */ }
        const evidenceId = observation.personaEvidenceId || observation.state?.personaEvidenceId || this.personaMemory.recordObservation(observation, { source: this.source, kind: 'visual' }).evidenceId;
        let viewing = observation.viewing;
        if (viewing) {
          if (viewing.evidenceId !== evidenceId || viewing.videoId !== observedState.video.id || typeof viewing.sampleId !== 'string' || typeof viewing.accepted !== 'boolean') throw failure('本次观看回执与作品观察不一致，没有写入兴趣。');
        } else viewing = this.viewing(evidenceId, current, observation, sampleStartedAt, `watch:${this.runId}:observe:${randomUUID()}`);
        observation = { ...observation, ...(viewing ? { viewing } : {}) };
        // local perf: 十几秒的短片，等模型答完它自己就播完了；这类由宿主看到尾，不花请求。
        if (!TEST_SHORT_COMMENTS.enabled && Number.isFinite(observedState.video.duration) && observedState.video.duration > 0 && observedState.video.duration <= WATCH_PACING.microSeconds) {
          this.onEvent({ type: 'watch.short', message: `${Math.round(observedState.video.duration)} 秒的短片，宿主直接看到尾，不花模型请求。` });
          // 短片也要在日记里留一条：没有模型判断，就写清楚它是被宿主看到尾的。
          await this.noteVideo(observedState);
          if (this.track) this.track.diary ||= `${Math.round(observedState.video.duration)} 秒的短片，还没等到我判断就播完了，算看完。`;
          current = await this.watchShort({ evidenceId, observedState, current, sampleStartedAt });
          this.deferDiary({ action: '停', ended: true });
          continue;
        }
        // ⚠️ 临时测试档（主人 2026-10-23 定）：2 分钟以内的作品一律看到底，然后直接发一条评论，
        // 不再问她“要不要评”。测完把 TEST_SHORT_COMMENTS.enabled 改成 false 就恢复原逻辑。
        if (TEST_SHORT_COMMENTS.enabled && Number.isFinite(observedState.video?.duration) && observedState.video.duration > 0 && observedState.video.duration <= TEST_SHORT_COMMENTS.maxSeconds) {
          this.onEvent({ type: 'watch.test_short', message: `测试档：${Math.round(observedState.video.duration)} 秒的作品，先看到底再直接评论。` });
          this.logDecision({ action: 'test_short_start', videoId: observedState.video.id, duration: observedState.video.duration });
          await this.noteVideo(observedState);
          let ended = false, missing = 0, seenMax = 0;
          for (let i = 0; i < 150; i++) {
            this.assertAllowed();
            // 2026-10-23：douyin_status 有时直接返回页面状态、有时包一层 .state；先前只取 .state 会拿到空对象，
            // 于是每次都判“没有视频”→ 6 秒放弃 → 一路秒划（实测 17:20 那轮）。
            const raw = await this.execute('douyin_status');
            const st = raw?.state || raw || {};
            // 2026-10-23：推荐流里经常读不到作品 id（id 为 null），不能因此当成“换片”，否则会一路秒划。
            if (!st.video || (!st.video.id && !Number.isFinite(st.video?.time))) {
              if (++missing > 6) break;
              await this.delayImpl(1_000, this.abort.signal);
              continue;
            }
            missing = 0;
            if (st.video.id && st.video.id !== observedState.video.id) break;
            const t = st.video.time, d = Number.isFinite(st.video.duration) ? st.video.duration : observedState.video.duration;
            if (Number.isFinite(t) && Number.isFinite(d)) {
              // 播到结尾算完；平台回开头（进度倒退）但之前已经贴近结尾，也算看完。
              if (t >= d - 1.5) { ended = true; break; }
              if (seenMax >= d - 3 && t < seenMax - 3) { ended = true; break; }
              seenMax = Math.max(seenMax, t);
            }
            if (st.video.paused) { try { await this.execute('douyin_play'); } catch { /* 接着等 */ } }
            await this.delayImpl(2_000, this.abort.signal);
          }
          if (!ended) {
            this.logDecision({ action: 'test_short_abort', videoId: observedState.video.id, reason: '没有等到结尾或已经换片', seenMax });
            this._finished = null;
          } else {
            this._finished = { videoId: observedState.video.id };
            this.deferDiary({ action: '停', ended: true });
            try {
              this.reserveRequest();
          const extraMention = pickExtraMention({ allowlist: readChatAllowlist(this.stateDir) });
          const generated = await this.commentAgent.generate({ observation, extraMention, signal: this.abort.signal, decisionProvider: this.decisionProvider });
              this.assertAllowed();
              if (generated.text !== null) {
                const delivery = await this.getCommentService().comment({ evidenceId, videoId: observedState.video.id, text: generated.text, ...(extraMention ? { extraMentionName: extraMention.name } : {}) }, { signal: this.abort.signal, watchRunId: this.runId });
                this.logDecision({ action: 'test_comment', videoId: observedState.video.id, confirmed: delivery?.confirmed === true, commentId: delivery?.commentId ?? null, reason: delivery?.reason ?? null, text: String(generated.text || '').slice(0, 40) });
                if (delivery?.deliveryUncertain) throw failure('测试档评论发布结果未确认，请在抖音核对。', 'needs_user');
              }
            } catch (error) {
              this.logDecision({ action: 'test_comment_error', videoId: observedState.video.id, error: String(error?.message || error).slice(0, 160) });
            }
            this._finished = null;
          }
          current = await this.execute('douyin_next');
          continue;
        }
        // 2026-10-27 主人定：决策 #1 用开头 3 秒的三张采样拼成一张；之后的决策用
        // 「中段帧 + 这次观察的三张」拼成一张（普通 4 格、最多 6 格；like 取最近 3 张中段帧 = 6 格）。
        // 拼图只占一张图片；装不进去就退回原来的首帧 + 末帧，不影响观看。
        if (WATCH_COMPOSITE.enabled) {
          // 标了 like 的作品中段帧多（5 秒一张），取最近 3 张 + 观察 3 张 = 6 格；普通作品取最近 2 张。
          // 喜欢后的 6 格：中段帧取最近 3 张（5/10/15/20 里的 10/15/20），加观察 3 张；
          // 这样 10 秒那张能进图，5 秒那张留给上一张决策图 C 的范围。普通作品仍是最近 2 张。
          const hotMidCount = Math.max(1, WATCH_COMPOSITE.maxFrames - 3);
          const midFrames = hotVideo ? stayPool.slice(-hotMidCount) : stayPool.slice(-2);
          const rawCompositeFrames = sampling ? sampleFrames : [...midFrames, ...sampleFrames];
          // 2026-10-27：26 秒刻度会同时出现「连看段末尾补帧」和「观察首帧」；默认 1.2 秒内算同一时刻，
          // 只留更晚的观察帧，B 从 5 格变 4 格（20 / 26 / 28 / 30），不再有两张 26。
          // 评论前最后那次观察（视频已停住）三张是同一画面，留首尾两张就够；
          // 不能只留 1 张——拼图至少 2 帧，只留 1 张 C 就不会进 storyboard，评论会看不到结尾。
          // 只认 `_finished`（由 watchStay/重播检测设置），不要用「暂停在结尾」兜底：
          // 那会把「已经停在结尾的第一条采样」也裁成 2 张，采样就少了中间帧。
          const atEnd = this._finished?.videoId === observedState.video.id;
          // 2026-10-27：结尾重播时当前观察是 0 秒开头；用刚补拍的结尾帧 + 重播首帧做 C，别把开头当结尾。
          const replayStart = atEnd && Number.isFinite(observedState.video?.time) && Number.isFinite(this.track?.position) && observedState.video.time < this.track.position - 3;
          const endFrame = replayStart && this._lastEndFrame?.videoId === observedState.video.id ? this._lastEndFrame : null;
          const cappedFrames = atEnd
            ? (endFrame ? [endFrame, ...sampleFrames.slice(-1)] : (sampleFrames.length > 2 ? [sampleFrames[0], sampleFrames[sampleFrames.length - 1]] : sampleFrames))
            : rawCompositeFrames;
          const compositeFrames = dedupeFramesByTime(cappedFrames, 1.2).slice(-WATCH_COMPOSITE.maxFrames);
          const columns = compositeFrames.length === 4 ? 2 : WATCH_COMPOSITE.columns;
          // 2026-10-29 主人定：开头采样也改成抽帧——5 秒、每秒一张、5 格拼一张，用来判断看不看。
          // 采样那两张截图只留作证据（persona 登记），进模型的是 canvas 抽出来的这张，没有界面、没有弹幕。
          let samplingSheet = null;
          if (sampling) {
            try {
              samplingSheet = await this.controller.grabSampleSheet(observedState.video.id, { count: WATCH_LIMITS.sampleCells, seconds: WATCH_LIMITS.sampleSeconds });
              if (samplingSheet) this.logDecision({ action: 'sampling_sheet', videoId: observedState.video.id, frames: samplingSheet.times, width: samplingSheet.width, height: samplingSheet.height, bytes: samplingSheet.bytes });
            } catch (error) {
              this.logDecision({ action: 'sampling_sheet_failed', videoId: observedState.video.id, reason: String(error?.message || error).slice(0, 90) });
            }
          }
          if (samplingSheet || compositeFrames.length >= 2) {
            try {
              const composite = samplingSheet || await this.controller.composeFrames(compositeFrames, { columns, cellHeight: WATCH_COMPOSITE.cellHeight, cropRightPx: WATCH_COMPOSITE.cropRightPx, cropBottomPx: WATCH_COMPOSITE.cropBottomPx, signal: this.abort.signal });
              const sheetTimes = samplingSheet ? samplingSheet.times : compositeFrames.map(frame => Number.isFinite(frame.time) ? Math.round(frame.time * 10) / 10 : null);
              const meta = { kind: sampling ? 'sampling' : 'observe', videoAt: observedState.video.time ?? null, frames: sheetTimes, dropped: samplingSheet ? 0 : rawCompositeFrames.length - compositeFrames.length, width: composite.width, height: composite.height, crop: composite.crop ?? null, bytes: composite.bytes, source: samplingSheet ? 'canvas' : 'screenshot' };
              this.logDecision({ action: 'composite', videoId: observedState.video.id, ...meta });
              // 2026-10-29 晚修：开头那张采样拼图以前不进 manifest，短作品干脆一帧都没有。
              // 现在每张拼图（采样/观察/结尾 C）都按格把时刻记进采集会话。
              try { this._captureSession?.addFrames({ videoId: observedState.video.id, times: meta.frames }); } catch { /* 记不上不影响观看 */ }
              observation = { ...observation, composite };
              if (this._storyboard?.videoId === observedState.video.id) {
                this._storyboard.composites.push({ ...composite, kind: meta.kind, times: meta.frames });
                if (this._storyboard.composites.length > WATCH_COMPOSITE.storyboardMax) {
                  const samplingComposite = this._storyboard.composites.find(item => item.kind === 'sampling');
                  const rest = this._storyboard.composites.filter(item => item !== samplingComposite).slice(-(WATCH_COMPOSITE.storyboardMax - (samplingComposite ? 1 : 0)));
                  this._storyboard.composites = samplingComposite ? [samplingComposite, ...rest] : rest;
                }
                observation = { ...observation, storyboard: this._storyboard.composites };
              }
            } catch (error) {
              this.onEvent({ type: 'watch.compose_failed', message: `拼图没生成，退回首尾两帧：${String(error?.message || error).slice(0, 100)}` });
            }
          }
        }
        // 2026-10-29 主人定（A）：采样决策只带开头 10 秒内的弹幕（5–8 条）。判的是"值不值得看"，
        // 整条的 top-20 会把结尾的高赞当成开头的证据；截到开头，文本量只有 100 字上下，几乎不加成本。
        if (sampling && WATCH_SAMPLING_DANMAKU.enabled && observedState.video?.id) {
          try {
            const opening = await this.controller.danmakuFor(observedState.video.id, {
              limit: WATCH_SAMPLING_DANMAKU.limit,
              duration: Number(observedState.video.duration) || null,
              maxTime: WATCH_SAMPLING_DANMAKU.seconds,
            });
            if (opening?.text) observation = { ...observation, danmaku: opening.text };
            this.logDecision({ action: 'sampling_danmaku', videoId: observedState.video.id, picked: opening?.picks?.length || 0, scoped: opening?.scoped ?? 0, total: opening?.total ?? 0, source: opening?.source ?? 'none' });
          } catch (error) {
            this.logDecision({ action: 'sampling_danmaku_failed', videoId: observedState.video.id, reason: String(error?.message || error).slice(0, 90) });
          }
        }
        // 2026-10-23：抖音播完会自己回到开头重播，宿主再把画面停住，于是模型看到的是「0 秒的暂停画面」，
        // 它以为没看过，继续选 stay（实测 15:55 就这样），评论机会又被白白放掉。这里告诉它这条已经播完。
        if (this._finished?.videoId && this._finished.videoId === observedState.video?.id) observation = { ...observation, finished: true };
        // 2026-10-23：16:10:39 判完看完之后，决策请求三分多钟没回来，只在日志里留了个洞。
        // 这里先记一条 decide_start，超时再用明确错误收尾，别再无声挂住。
        this.logDecision({ action: 'decide_start', videoId: observedState.video?.id ?? null, paused: observedState.video?.paused ?? null, finishedId: this._finished?.videoId ?? null });
        const context = this.personaMemory.context({ compact: true }), shareContext = this.shareContext(), commentContext = this.commentContext();
        await this.noteVideo(observedState);
        // 2026-10-28 主人定：看完的那条不再先问一次「评不评」，直接把整条时间线交给评论模型。
        const directComment = Boolean(this._pendingEndComment) && this._pendingEndComment === this._finished?.videoId && this._finished?.videoId === observedState.video?.id;
        let result = null, decision;
        if (directComment) {
          this._pendingEndComment = null;
          decision = { action: 'comment', reason: '看到结尾，直接交给评论模型决定评不评。', topics: [], reflection: '', seconds: null };
          this.logDecision({ action: 'end_comment_direct', videoId: observedState.video?.id ?? null });
        } else {
        this.reserveRequest();
        result = await this.agent.decideWatch({ observation, context, shareContext, commentContext, signal: this.abort.signal, decisionProvider: this.decisionProvider });
        this.assertAllowed();
        try {
          decision = redact(parseWatchDecision(result.decision, { shareContext: this.shareContext(), commentContext: this.commentContext() }), [this.config.apiKey]);
        } catch (error) {
          this.logDecision({ action: 'parse_error', error: String(error?.message || error).slice(0, 160), videoId: observedState.video?.id ?? null, finishedId: this._finished?.videoId ?? null, commentEnabled: this.commentContext().enabled });
          // 看完停住时，模型硬选了当前不可用的 comment（比如评论没开）不该把整轮判死：记一笔，换下一条。
          if (this._finished && /评论/.test(String(error.message || ''))) {
            this.onEvent({ type: 'watch.comment_refused', message: `评论这个动作现在不可用，换下一条：${error.message}` });
            this._finished = null;
            current = await this.execute('douyin_next');
            continue;
          }
          throw error;
        }
        }
        this.noteDecision(decision, observedState);
        this.logDecision({ action: decision.action, seconds: decision.seconds ?? null, videoId: observedState.video?.id ?? null, paused: observedState.video?.paused ?? null, time: observedState.video?.time ?? null, duration: observedState.video?.duration ?? null, finishedId: this._finished?.videoId ?? null, commentEnabled: this.commentContext().enabled, title: String(observedState.video?.title || '').slice(0, 30) });
        current = await this.execute('douyin_status');
        const freshState = current.state || current, freshAt = this.now(), modelWaitSeconds = (freshAt - observedAt) / 1000;
        let gapTrusted = false, waited = null;
        if (freshState.video?.id === observedState.video.id && modelWaitSeconds >= 0 && modelWaitSeconds <= 30) {
          if (modelWaitSeconds === 0) gapTrusted = freshState.video.time === observedState.video.time && freshState.video.duration === observedState.video.duration && freshState.video.paused === false && observedState.video.paused === false && freshState.video.readyState >= 2;
          else {
            try {
              waited = this.viewing(evidenceId, observation, current, observedAt, `watch:${this.runId}:model-wait:${randomUUID()}`);
              gapTrusted = waited?.accepted === true || waited?.reason === 'stalled' && freshState.video.paused === false && observedState.video.paused === false;
            } catch (error) {
              if (!['PERSONA_EVIDENCE', 'PERSONA_ARGUMENT'].includes(error.code)) throw error;
              this.onEvent({ type: 'watch.learning_skipped', message: '模型等待期间的播放状态不可用于学习，本次没有补记观看或快划偏好。' });
            }
          }
        }
        this.save({ lastDecision: decision, usage: result?.usage }); this.onEvent({ type: 'watch.decision', decision, usage: result?.usage });
        // 2026-10-26：以前每次决策的用量只活在 watch-state.json 里（被下一条覆盖），跑完就查不到账。
        // 这里落一条 decision_usage，15 分钟这类测量可以直接从日志里加总，不依赖外部采样器。
        if (result) this.logDecision({ action: 'decision_usage', videoId: observedState.video?.id ?? null, decision: decision.action, usage: result.usage || {} });
        // local add: like 的作品连看补帧从 20 秒缩到 5 秒（只影响这一条，换片自动恢复）。
        this.applyPacing(decision, observedState.video);
        if (decision.action === 'stop') { await this.flushDiary({ position: freshState.video?.time }); break; }
        let learned = false;
        if (decision.action === 'skip') {
          // 划走之前先把这条写进日记——后面切换失败、整轮收尾都不该把记录丢了。
          await this.flushDiary({ action: '划', position: freshState.video?.time });
          current = await this.execute('douyin_next');
          // local fix 2: 直播的可靠标志是「没有时长」，不一定「没有 id」——旧逻辑在
          // duration === null 时 break 出去，此时若 id 已存在，就会被当成新作品接着看。
          // 现在给慢页面几次重读；连读两次都拿不到时长就判直播，跳过这一条。
          let landed = current.state || current;
          for (let attempt = 0; attempt < 4; attempt++) {
            const v = landed.video;
            if (v?.id && v.duration != null) break;            // 正常作品，落定
            if (v && v.duration == null && attempt >= 1) break;  // 连读两次仍无时长 → 直播
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const reread = await this.execute('douyin_status');
            landed = reread.state || reread;
          }
          const next = landed.video;
          if (next && next.duration == null) {
            this.onEvent({ type: 'watch.live_skipped', message: '下一条是直播，本轮跳过它。' });
            continue;
          }
          // local fix 3: 有些页（长视频、合集详情）读不到作品 id 也读不到 /video/ 链接。
          // 此时只要标题变了，就算确实换到了新作品，不要因为拿不到 id 就收尾。
          const movedByTitle = Boolean(next?.title) && next.title !== observedState.video?.title;
          if (!next || (next.id ? next.id === observedState.video.id : !movedByTitle)) {
            this.onEvent({ type: 'watch.switch_unconfirmed', message: '切换后未确认到新作品，本轮提前收尾。' });
            break;
          }
          current = landed;
          if (gapTrusted && (viewing?.accepted === true || waited?.accepted === true)) learned = this.behavior(evidenceId, 'skip')?.accepted === true;
        } else if (decision.action === 'search') {
          await this.flushDiary({ position: freshState.video?.time });
          const found = await this.execute('douyin_search', { query: decision.query });
          const first = (found.state || found).searchResults?.find(item => Number.isSafeInteger(item.index) && item.index >= 0);
          if (!first) throw failure('搜索没有返回可核对的作品，已停止自主观看。');
          current = await this.execute('douyin_open_video', { index: first.index });
        } else if (decision.action === 'comment') {
          if (freshState.video?.id !== observedState.video.id) throw failure('评论前作品已变化，未发布评论。', 'needs_user');
          // 只对看完的作品评论（2026-10-22 主人定）：没看完的一律不评，继续看。
          // 2026-10-23：她在 370/371 秒就判“已播到结尾”选了 comment，宿主却只在真正回开头/暂停时才置 finished，
          // 于是被这条闸门直接顶回去（实测 16:30:20）。差 3 秒以内一律算看完，别把她的判断硬驳回。
          const nearVideo = observedState.video;
          const nearEnd = Number.isFinite(nearVideo?.duration) && nearVideo.duration > 0 && Number.isFinite(nearVideo?.time) && nearVideo.time >= nearVideo.duration - 3;
          if (this._finished?.videoId !== observedState.video.id && nearEnd) {
            this._finished = { videoId: observedState.video.id };
            this.logDecision({ action: 'comment_near_end', videoId: observedState.video.id, time: nearVideo.time, duration: nearVideo.duration });
          }
          if (this._finished?.videoId !== observedState.video.id && this.enoughWatched(nearVideo)) {
            this._finished = { videoId: observedState.video.id };
            this.logDecision({ action: 'comment_long_80pct', videoId: observedState.video.id, time: nearVideo?.time ?? null, duration: nearVideo?.duration ?? null });
          }
          if (this._finished?.videoId !== observedState.video.id) { this.onEvent({ type: 'watch.comment_refused', message: '这条还没看到结尾，不评论。' }); this.logDecision({ action: 'comment_refused', videoId: observedState.video.id, time: nearVideo?.time ?? null, duration: nearVideo?.duration ?? null }); continue; }
          // 2026-10-26：私信正在看分享视频时会把页面按住（watch-hold.flag）。这时候发评论会跟它抢同一个
          // 标签页——实测评论正文被导航冲掉，报「没有完整进入输入框」还把整轮判死。先等它看完。
          if (this.isHeld()) { await this.waitWhileHeld(); this.assertAllowed(); }
          this.reserveRequest();
          // 2026-10-29：评论的画面换成抽帧故事板（最多 3 张、每张 9–16 格），再带上打上时间的高赞弹幕。
          // 两个都拿不到就退回原来的拼图和转写，评论照写。
          try {
            const media = await this.prepareCommentMedia(observedState.video.id, Number(observedState.video.duration) || null);
            observation = { ...observation, sheets: media.sheets, danmaku: media.danmaku, transcript: media.transcript };
          } catch (error) {
            this.logDecision({ action: 'comment_media_failed', videoId: observedState.video.id, reason: String(error?.message || error).slice(0, 90) });
          }
          // 2026-10-26：换成"跟主人说话"的口吻后，模型写出「我看完了」「我会…」这类句子，被 validateCommentText
          // 的安全规则直接抛错；而这一抛在 try 之外，整轮就 failed（15:37 实测）。校验没过 = 这条不评，换下一条。
          // 2026-10-26 主人定：评论默认 @ 主人，另有概率再 @ 一位白名单好友；先挑好人，文案和 @ 用同一个。
          const extraMention = pickExtraMention({
            allowlist: readChatAllowlist(this.stateDir),
            none: mentionNoneProbability(this.stateDir),
            onRoll: (info) => this.logDecision({ action: 'mention_roll', videoId: observedState.video.id, ...info }),
          });
          // 2026-10-28 主人要看完整过程：评论这一刻的展写也存一份，和拼图放同一个目录。
          try {
            const roll = path.join(resolveRuntimePaths().stateDir, 'rolling', 'rolling.txt');
            const text = fs.readFileSync(roll, 'utf8').trim();
            if (text) {
              const dir = path.join(resolveRuntimePaths().stateDir, 'composites');
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, String(observedState.video.id) + '-transcript.txt'), text);
            }
          } catch { /* 没有转写就跳过 */ }
          let generated;
          try {
            generated = await this.commentAgent.generate({ observation, extraMention, signal: this.abort.signal, decisionProvider: this.decisionProvider });
          } catch (error) {
            const message = String(error?.message || error);
            if (/不能编造现实经历|公开评论不能包含|评论须为|只接受|评论模型没有返回有效JSON|评论模型响应未完整结束|评论模型没有返回有限的普通JSON|评论模型返回了未允许字段/.test(message)) {
              this.logDecision({ action: 'comment_skipped', videoId: observedState.video.id, reason: message.slice(0, 90) });
              this.onEvent({ type: 'watch.comment_skipped', message: `评论没过安全校验（${message.slice(0, 30)}），这条不评，换下一条。` });
              current = await this.execute('douyin_next');
              this._finished = null;
              continue;
            }
            throw error;
          }
          this.assertAllowed();
          if (generated.text !== null) {
            let delivery;
            try {
              delivery = await this.getCommentService().comment({ evidenceId, videoId: observedState.video.id, text: generated.text, ...(extraMention ? { extraMentionName: extraMention.name } : {}) }, { signal: this.abort.signal, watchRunId: this.runId });
            } catch (error) {
              // 2026-10-24：同一条作品今天已经评过时，去重会直接抛错；这不是故障，换下一条就行，
              // 以前这一抛会把整轮判 failed（实测 14:41 那次）。
              if (/同一作品已处理过评论|已有发布或待核对评论收据|已处理过评论/.test(String(error?.message || error))) {
                this.logDecision({ action: 'comment_duplicate', videoId: observedState.video.id });
                this.onEvent({ type: 'watch.comment_duplicate', message: '这条作品今天已经评过，换下一条。' });
                current = await this.execute('douyin_next');
                this._finished = null;
                continue;
              }
              // 2026-10-26：正文没进输入框 = 什么都没发出去，跳过这条继续看，不必把整轮停下等人。
              if (/没有完整进入输入框|@ 没有挂成整块/.test(String(error?.message || error))) {
                this.logDecision({ action: 'comment_skipped', videoId: observedState.video.id, reason: String(error?.message || error).slice(0, 80) });
                this.onEvent({ type: 'watch.comment_skipped', message: '评论正文没进输入框（可能被私信占页打断），这条不评，换下一条。' });
                current = await this.execute('douyin_next');
                this._finished = null;
                continue;
              }
              throw error;
            }
            // 2026-10-26：把这次挑中的第二个人记下来，方便核对「@ 的人和文案里的称呼是不是同一个」。
          this.logDecision({ action: 'comment_sent', videoId: observedState.video.id, confirmed: delivery?.confirmed === true, extraMention: extraMention ? extraMention.name : null, extraAlias: extraMention ? extraMention.alias : '', usage: generated.usage || {} });
          this.onEvent({ type: 'watch.comment', delivery, usage: generated.usage, extraMention: extraMention ? { name: extraMention.name, alias: extraMention.alias } : null });
            if (delivery?.deliveryUncertain) throw failure('评论发布结果未确认，请在抖音核对，已停止自主观看。', 'needs_user');
            // 2026-10-24：评论框没打开/页面不适配属于“这条不评”，不该把整轮判死（18:30 实测被它停过）。
            if (delivery?.confirmed !== true && delivery?.needsUserAction) {
              // 2026-10-26：这条分支原来只发事件、不落日志，事后查不出原因（15:22 那次就是）。
              this.logDecision({ action: 'comment_skipped', videoId: observedState.video.id, reason: String(delivery.reason || '评论框没有出现').slice(0, 120) });
              this.onEvent({ type: 'watch.comment_skipped', message: delivery.reason || '评论框没有出现，跳过这条评论。' });
            }
            // 2026-10-26：comment-browser 的 post() 是**返回**带 reason 的结果、不抛异常，所以上一版放在 catch 里的
            // 「正文没进框就跳过」永远不会触发。这里按 reason 认：输入框类问题一律跳过，别判死整轮。
            else if (delivery?.confirmed !== true && /没有完整进入输入框|已有草稿|不是评论框|处于回复他人/.test(String(delivery?.reason || ''))) {
              this.logDecision({ action: 'comment_skipped', videoId: observedState.video.id, reason: String(delivery.reason || '').slice(0, 80) });
              this.onEvent({ type: 'watch.comment_skipped', message: `评论没发出去（${String(delivery.reason || '').slice(0, 40)}），这条不评，换下一条。` });
            }
            else if (delivery?.confirmed !== true) throw failure(delivery?.reason || '没有确认公开评论发布成功。', 'needs_user');
          }
          // 评论完（或她决定不留）就换下一条，清掉停住状态。
          current = await this.execute('douyin_next');
          this._finished = null;
          continue;
        } else if (decision.action === 'share') {
          const delivery = await this.getShareService().share({ evidenceId, videoId: observedState.video.id, recipientId: decision.recipientId, reason: decision.reason }, { signal: this.abort.signal, watchRunId: this.runId });
          this.onEvent(redact({ type: 'watch.share', delivery }, [this.config.apiKey]));
          if (delivery?.deliveryUncertain) throw failure('分享结果未确认，已停止自主观看，请在抖音核对原收据。', 'needs_user');
          if (delivery?.confirmed === true && delivery.deliveryType === 'native-card' && delivery.videoId === observedState.video.id && delivery.recipientId === decision.recipientId && typeof delivery.operationId === 'string' && delivery.operationId && typeof delivery.messageId === 'string' && delivery.messageId) learned = this.behavior(evidenceId, 'share', delivery.operationId)?.accepted === true;
          else if (delivery?.confirmed === true) throw failure('分享收据缺少可核对的同作品与好友身份，已停止自主观看。', 'needs_user');
        } else if (decision.action === 'stay') {
          const beforeState = freshState;
          if (beforeState.video?.id !== observedState.video.id) throw failure('停留前作品已变化，已停止自主观看，没有学习本次停留。', 'needs_user');
          // 2026-10-24：已经判过「看完」的作品，再选 stay 一律换下一条。
          // 原来只在「暂停在结尾」时拦，一旦它被 play 成从头重播（playing）就漏过去了，于是同一支短片看三遍。
          if (!this._finished && this.seenEnd(observedState.video)) {
            this.logDecision({ action: 'stay_after_seen_end', videoId: observedState.video.id, time: beforeState.video?.time ?? null, duration: beforeState.video?.duration ?? null });
            this.onEvent({ type: 'watch.finished', message: '这条已经到过结尾（或 80%），不再重看，换下一条。' });
            current = await this.execute('douyin_next');
            this._maxPos = {};
            continue;
          }
          if (this._finished?.videoId === observedState.video.id) {
            this.logDecision({ action: 'stay_after_finished', videoId: observedState.video.id, time: beforeState.video?.time ?? null, duration: beforeState.video?.duration ?? null });
            this.onEvent({ type: 'watch.finished', message: '这条已经判过看完，不再重看，换下一条。' });
            current = await this.execute('douyin_next');
            this._finished = null;
            continue;
          }
          if (beforeState.video.paused !== false) {
            const video = beforeState.video;
            const atEnd = Number.isFinite(video?.duration) && Number.isFinite(video?.time) && video.duration > 0 && video.time >= video.duration - 1.5;
            // 模型回答期间短片就播完了：算看完，换下一条，不把整轮判死。
            // 2026-10-23：如果这条已经判定播完、只是被平台重播停在了开头，她要的“再看一会儿”执行不了，
            // 换下一条并记一笔即可——以前这里直接判 needs_user，整轮白跑（实测 15:55）。
            if (!atEnd && this._finished?.videoId === video.id) {
              this.logDecision({ action: 'stay_after_finished', videoId: video.id, time: video.time, duration: video.duration });
              this.onEvent({ type: 'watch.finished', message: '这条已经播完（画面被重播拉回开头），换下一条。' });
              current = await this.execute('douyin_next');
              this._finished = null;
              continue;
            }
            if (!atEnd) {
              // 2026-10-24：私信/回复轮询打开弹层会把视频暂停，之前这里直接判死整轮。
              // 现在先尝试恢复播放一次，能接着播就不算故障。
              let resumed = false;
              try {
                const played = await this.execute('douyin_play');
                const after = played.state || played;
                resumed = after.video?.paused === false && after.video?.id === video.id;
              } catch { /* 恢复不了就走原来的失败分支 */ }
              if (resumed) { this.onEvent({ type: 'watch.resumed', message: '作品被外部暂停，已恢复播放。' }); current = await this.execute('douyin_status'); continue; }
              throw failure('停留前作品被暂停，已停止自主观看，没有学习本次停留。', 'needs_user');
            }
            this.onEvent({ type: 'watch.finished', message: '模型回答期间作品播到了结尾，换下一条。' });
            current = await this.execute('douyin_next');
            continue;
          }
          const result = await this.watchToEnd({ evidenceId, current });
          current = result.current; learned = learned || result.learned;
          if (result.finished) {
            // A 方案：看完先停住，回外层再问一次「要不要留一句评论」（这也正好是「只对看完的作品评论」）。
            this._finished = { videoId: result.finishedVideoId || observedState.video.id };
            // 2026-10-28 主人定：看完不再先问「评不评」，下一次观察后直接把整条时间线交给评论模型。
            this._pendingEndComment = this._finished.videoId;
            this.logDecision({ action: 'stay_finished', videoId: this._finished.videoId, time: beforeState?.video?.time ?? null, duration: beforeState?.video?.duration ?? null });
            this.onEvent({ type: 'watch.finished_pending', message: '这条看完了，停住等一次判断（评论 / 下一条）。' });
            // 2026-10-23：平台播完会立刻切到下一条。要评的那条已经不在当前页上，
            // 就回到它的详情页并暂停——否则评论会以「当前作品不一致 / 还没看到结尾」被拒掉。
            const shownId = current?.state?.video?.id ?? current?.video?.id ?? null;
            if (this._finished.videoId && shownId !== this._finished.videoId) {
              try {
                current = await this.execute('douyin_open_video', { url: `https://www.douyin.com/video/${this._finished.videoId}` });
                try { await this.execute('douyin_play'); } catch { /* 打开后自己会播 */ }
              } catch {
                // 打开视频偶尔会报「执行上下文被销毁」（其实已经导航过去了）：按当前页面再核一次，别白白放弃这次评论。
                const landed = await this.execute('douyin_status').catch(() => null);
                const landedId = landed?.state?.video?.id ?? landed?.video?.id ?? null;
                if (landedId !== this._finished?.videoId) this._finished = null;
              }
            }
            continue;
          }
        }
        if (learned && decision.topics.length) this.personaMemory.updateAgentInterests({ evidenceId, topics: decision.topics, reflection: decision.reflection }, { source: this.source });
        if (['share', 'comment'].includes(decision.action)) current = await this.execute('douyin_status');
      }
    } catch (error) {
      const reason = this.abort?.signal.aborted ? this.abort.signal.reason || error : error;
      status = reason.watchStatus || 'failed'; lastError = redact(reason.message || String(reason), [this.config.apiKey]);
    } finally {
      clearInterval(this.heartbeat); clearTimeout(this.deadline);
      try { this.rolling?.kill?.(); } catch { /* 收尾失败不影响轮次 */ }
      this.rolling = null;
      // 先等排队中的日记写完，再补最后一条，顺序才不会乱。
      // 收尾时不再让路（否则 _finished 还在的话会白等 90 秒）。
      this._diaryStopWait = true;
      try { await this.diaryChain; } catch { /* 队列内部已各自记过事件 */ }
      // 轮次到点/被停止时还停在某条作品上：把这一条也写进日记，别让最后一条漏掉。
      // 2026-10-25：离开方式按真实的收尾原因写，别再一律写成「轮次到点」。
      const endMode = !this.abort?.signal.aborted ? '这一轮结束'
        : status === 'limited' ? '轮次到点'
        : status === 'stopped' ? '主人手动停止'
        : '异常中断';
      // 2026-10-29 晚修：以前只收 track 上那一条，换片后内存里其余记录随进程一起丢了。
      // 现在把这一轮采过的每条都写进各自的 manifest（与磁盘上已有的合并，不覆盖上一轮）。
      try { this._captureSession?.finalizeAll(endMode); } catch { /* 会话收尾失败不影响轮次 */ }
      // 抽帧循环要跟着轮次一起收掉，不然页面里会一直 2fps 抓帧。
      try { await this.controller.stopFrameGrab(); } catch { /* 没有采集器就算了 */ }
      await this.flushDiary({ position: this.track?.position, endMode });
      try { if (this.worker()?.owned) await this.controller.pauseForLimits?.(); } catch (error) { status = 'failed'; lastError ||= redact(error.message, [this.config.apiKey]); }
      try {
        for (let attempt = 0; ; attempt++) {
          try { this.control(() => { const worker = this.worker(); if (worker?.owned) { this.save({ status, lastError }); fs.unlinkSync(this.files.lock); const request = read(this.files.stop, null); if (request?.runId === this.runId) fs.unlinkSync(this.files.stop); } }); break; }
          catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
        }
      } catch (error) { status = 'failed'; lastError ||= error.message; }
      this.running = false; if (!this.worker()?.owned) this.runId = null;
      try {
        if (!this.reportService && this.personaMemory.stateFile) this.reportService = new DailyReport({ personaMemory: this.personaMemory, now: this.now });
        for (const date of new Set([this.startedDate || day(this.now()), day(this.now())])) {
          const report = await this.reportService?.generate({ date, reason: 'watch-finished' });
          if (report) this.onEvent({ type: 'watch.report', report: { date: report.date, path: report.path, observedCount: report.observedCount } });
        }
      } catch (error) { this.onEvent({ type: 'watch.report_failed', message: error.message || String(error) }); }
      this.onEvent({ type: `watch.${status}`, message: lastError || '自主观看已停止。' });
    }
    return this.state();
  }
  async stop({ explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('停止共享自主观看需要用户明确操作。'), { status: 403 });
    const worker = this.worker();
    if (worker?.owned) { this.abort?.abort(failure('用户停止自主观看。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); }
    else if (worker?.alive) this.control(() => { const current = this.worker(); if (current?.runId === worker.runId) write(this.files.stop, { runId: worker.runId, requestedAt: this.now() }); });
    else if (worker) this.control(() => { if (this.worker()?.runId === worker.runId) { fs.unlinkSync(this.files.lock); write(this.files.state, { status: 'stopped', sessionId: worker.sessionId, source: worker.source, lastError: '已清理退出进程的残留锁，预算继续保留。' }); } });
    return this.state();
  }
  async close() { if (this.worker()?.owned) { this.abort?.abort(failure('本入口已关闭。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); } if (this.ownsShareService) await this.shareService.close(); if (this.ownsCommentService) await this.commentService.close(); }
}




