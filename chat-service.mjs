import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { randomUUID } from 'node:crypto';
import { ChatAgent } from './chat-agent.mjs?v=9';
import { loadApiConfig, redact } from './api-agent.mjs';
import { messageFingerprint } from './chat-message.mjs';
import { OutboundCoordinator } from './outbound-send.mjs';

// 2026-10-28 主人定：分享视频的采样跟着推荐流走——1.5 秒一张、共 6 张（7.5 秒窗口）。
const WATCH_SAMPLE_SECONDS = 7.5;
const WATCH_SAMPLE_FRAMES = 6;

const basePolicy = () => ({ version: 1, enabled: false, allowlist: [], dailyReplyLimit: 40 });
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const load = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const alive = (pid) => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
function initialize(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); let descriptor; try { descriptor = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return; throw error; } try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); } finally { fs.closeSync(descriptor); } }
function recentEvents(file) {
  if (!fs.existsSync(file)) return [];
  const descriptor = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(descriptor).size; const length = Math.min(size, 65_536); const buffer = Buffer.alloc(length); fs.readSync(descriptor, buffer, 0, length, size - length); const lines = buffer.toString('utf8').split('\n'); if (size > length) lines.shift(); return lines.filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-30); }
  finally { fs.closeSync(descriptor); }
}
function validatePolicy(policy) {
  if (!Number.isSafeInteger(policy.dailyReplyLimit) || policy.dailyReplyLimit < 1 || policy.dailyReplyLimit > 200) throw new Error('私信每日请求上限须在 1 至 200 之间。');
  if (!Array.isArray(policy.allowlist) || policy.allowlist.length > 10 || new Set(policy.allowlist.map((item) => item.id)).size !== policy.allowlist.length) throw new Error('白名单最多十个不同联系人。');
  for (const item of policy.allowlist) if (typeof item.id !== 'string' || !item.id || item.id.length > 500 || item.followed !== true || item.isGroup !== false || !item.verifiedAt) throw new Error('白名单联系人必须已有关注关系与非群聊核对记录。');
  // 2026-10-26 主人定：每个好友可以有一条「备注称呼」，回复时就按这个叫法称呼对方。
  for (const item of policy.allowlist) if (item.alias !== undefined && (typeof item.alias !== 'string' || [...item.alias].length > 30)) throw new Error('联系人备注须是不超过 30 个字的文本。');
  return policy;
}
function messagesOf(snapshot) {
  if (snapshot?.loginRequired || snapshot?.verificationRequired || snapshot?.blocked) throw new Error('抖音私信需要手动登录、验证或解除页面限制。');
  if (!Array.isArray(snapshot?.messages)) throw new Error('没有读到可靠的私信消息列表。');
  const messages = snapshot.messages.map((message) => ({ ...structuredClone(message), sender: message.sender || message.direction }));
  if (messages.some((message) => typeof message.id !== 'string' || !message.id || !['incoming', 'outgoing', 'unknown'].includes(message.sender))) throw new Error('私信消息缺少稳定 ID 或方向，未回复。');
  return messages;
}

// 2026-10-25 20:40：转写为空不等于没声音。分享的短片常常只有呼吸声、语气词，SenseVoice 转出来就是空的。
// 这里只陈述客观事实（有没有音轨、多少 KB、多响、动态大不大），让看片笔记能说「有声音，但没有人声成句」，
// 而不是从空转写反推出「没录到声音」。
export function describeAudio(listened, transcript = '') {
  const audio = listened?.audio || {};
  if (listened?.audioAvailable === false) return '音频开关没开，没录到声音。';
  if (!audio.hasAudio) return '这段没采集到可用音轨。';
  const seconds = Number(audio.seconds) || 0;
  const kb = Math.round(Number(audio.bytes || 0) / 1024);
  const facts = [`有音轨（${kb} KB / ${seconds} 秒）`];
  const rms = Number(audio.loudness?.rms);
  const peak = Number(audio.loudness?.peak);
  if (Number.isFinite(rms) && rms > 0 && Number.isFinite(peak) && peak > 0) {
    const toDb = (value) => (20 * Math.log10(value)).toFixed(1);
    facts.push(`平均 ${toDb(rms)} dBFS、峰值 ${toDb(peak)} dBFS`);
    facts.push(peak / rms > 6 ? '动态大（有明显起伏）' : '动态平（音量稳）');
  }
  const said = String(transcript || '').trim();
  facts.push(said ? `转写：「${said.slice(0, 120)}」` : '转写里没有成句的人声（只有语气词、呼吸声这类）');
  return facts.join('，');
}

// 沿用视频工具的本机配置与直接 API 请求；私信状态及正文只写本机 state。
// 2026-10-25：按会话行上的未读角标决定这一轮读哪几个白名单会话。
// 行没渲染出来、或者身份对不上 → 不敢判它没有未读，一律算「要读」。
// （2026-10-24 那次「已读不回」就是半渲染时把 0 当成没消息，这里把未知当有。）
export function planUnreadFilter({ rows = [], allowlist = [], mustRead = [] } = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row.id === 'string') : [];
  const known = new Set(list.map((row) => row.id));
  const allowIds = new Set(allowlist.map((item) => item.id));
  const unread = new Set(list.filter((row) => row.unread === true && allowIds.has(row.id)).map((row) => row.id));
  const missing = allowlist.map((item) => item.id).filter((id) => !known.has(id));
  for (const id of [...mustRead, ...missing]) unread.add(id);
  return { unread, missing, anyWhitelist: allowlist.some((item) => unread.has(item.id)), rows: list.length };
}

export class ChatService {
  constructor({ browser, config = loadApiConfig(), agent = new ChatAgent({ config }), stateDir = resolveRuntimePaths().stateDir, pollIntervalMs = 30_000, outboundCoordinator } = {}) {
    if (!browser?.listContacts || !browser?.readConversation || !browser?.sendMessage) throw new Error('缺少私信浏览器控制器。');
    Object.assign(this, { browser, config, agent, stateDir, pollIntervalMs });
    this.outbound = outboundCoordinator ?? new OutboundCoordinator({ stateDir, source: String(browser.controller?.source || '').startsWith('dsh') ? 'dsh' : 'api' });
    this.policyFile = path.join(stateDir, 'chat-policy.json');
    this.watermarkFile = path.join(stateDir, 'chat-watermarks.json');
    this.logFile = path.join(stateDir, 'chat-events.jsonl');
    this.lockFile = path.join(stateDir, 'chat-loop.lock'); this.stopFile = path.join(stateDir, 'chat-stop.request.json'); this.guardFile = path.join(stateDir, 'chat-control.guard');
    this.policy = validatePolicy(load(this.policyFile, basePolicy()));
    this.watermarks = load(this.watermarkFile, { version: 1, contacts: {}, days: {} });
    this.running = false; this.busy = false; this.timer = null; this.abort = null; this.starting = null; this.runId = null; this.heartbeat = null; this.ownershipLost = false;
    this.events = [];
    if (!fs.existsSync(this.watermarkFile)) initialize(this.watermarkFile, this.watermarks);
    if (!fs.existsSync(this.policyFile)) initialize(this.policyFile, this.policy);
  }

  log(type, value = {}) {
    const event = redact({ at: new Date().toISOString(), type, ...value }, [this.config?.apiKey]);
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.appendFileSync(this.logFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.events.push(event); if (this.events.length > 100) this.events.shift();
  }
  persist() { if (this.ownershipLost) throw new Error('回复进程已失去锁，未覆盖其他入口的水位。'); if (this.runId) this.assertOwned(); save(this.watermarkFile, this.watermarks); }
  control(action) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const token = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('另一个入口正在更新回复锁，或控制锁需要人工核对；未自动删除控制锁。'), { code: 'CHAT_CONTROL_BUSY' }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
    finally { fs.closeSync(descriptor); }
    try { return action(); }
    finally { const current = load(this.guardFile, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.guardFile); }
  }
  loseOwnership() {
    if (this.ownershipLost) return;
    this.ownershipLost = true; this.running = false;
    clearInterval(this.timer); clearInterval(this.heartbeat); this.timer = null; this.heartbeat = null;
    this.abort?.abort(new Error('回复进程已失去 worker 锁，已停止操作。'));
    this.runId = null;
    this.log('worker.ownership_lost', { message: '已停止旧入口，不改新入口的锁、配置或水位。' });
  }
  assertOwned() { const worker = this.worker(); if (!this.runId || worker?.owned !== true || worker.pid !== process.pid) { this.loseOwnership(); throw new Error('回复进程已失去 worker 锁，未继续操作。'); } return worker; }
  worker() {
    try { const worker = load(this.lockFile, null); return worker ? { ...worker, alive: alive(worker.pid), heartbeatFresh: Date.now() - Date.parse(worker.heartbeatAt) < 10_000, owned: worker.runId === this.runId } : null; }
    catch { return fs.existsSync(this.lockFile) ? { alive: Date.now() - fs.statSync(this.lockFile).mtimeMs < 30_000, owned: false, status: 'starting', note: '锁文件尚未写完，暂不启动第二个回复进程。' } : null; }
  }
  acquire() {
    this.control(() => {
      const existing = this.worker();
      if (existing?.alive) throw new Error('另一个入口已经运行私信自动回复；请使用状态或停止工具。');
      if (existing) fs.unlinkSync(this.lockFile);
      const descriptor = fs.openSync(this.lockFile, 'wx', 0o600);
      this.runId = randomUUID(); this.ownershipLost = false;
      try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: 'starting' })); }
      finally { fs.closeSync(descriptor); }
      this.watermarks = load(this.watermarkFile, { version: 1, contacts: {}, days: {} });
      for (const mark of Object.values(this.watermarks.contacts)) if (mark.status === 'inflight') { mark.status = 'delivery-uncertain'; mark.reason = '上次进程在发送确认前结束，请人工核对。'; }
      this.persist();
    });
    this.heartbeat = setInterval(() => {
      try {
        this.assertOwned();
        const request = load(this.stopFile, null);
        if (request?.targetRunId === this.runId && (this.running || this.starting)) this.stop();
        if (this.runId) this.control(() => { this.assertOwned(); save(this.lockFile, { pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: this.running ? 'running' : this.starting ? 'starting' : 'stopping' }); });
        if (!this.running && !this.busy && !this.starting) this.release();
      } catch (error) { if (error.code !== 'CHAT_CONTROL_BUSY') this.log('worker.control_error', { message: error.message }); }
    }, 1000); this.heartbeat.unref?.();
  }
  release() {
    if (!this.runId || this.busy || this.starting) return;
    try { this.control(() => { this.assertOwned(); const policy = validatePolicy(load(this.policyFile, this.policy)); policy.enabled = false; save(this.policyFile, policy); fs.unlinkSync(this.lockFile); }); }
    catch (error) { if (error.code === 'CHAT_CONTROL_BUSY') return; if (this.ownershipLost) return; throw error; }
    clearInterval(this.heartbeat); this.heartbeat = null; this.runId = null;
  }
  state() {
    const worker = this.worker();
    if (!worker?.owned) { this.policy = validatePolicy(load(this.policyFile, this.policy)); this.watermarks = load(this.watermarkFile, this.watermarks); this.events = recentEvents(this.logFile); }
    return { running: this.running || Boolean(worker?.alive && worker.status === 'running'), starting: Boolean(this.starting || worker?.status === 'starting'), busy: this.busy, worker, coordination: { protocol: 'guard-v1', guardPresent: fs.existsSync(this.guardFile) }, pollSeconds: this.pollIntervalMs / 1000, replyTokens: this.agent.replyTokens ?? 512, policy: this.policy, daily: { date: dayKey(), requests: this.watermarks.days[dayKey()] ?? 0, limit: this.policy.dailyReplyLimit }, contacts: Object.entries(this.watermarks.contacts).filter(([id]) => this.policy.allowlist.some((item) => item.id === id)).map(([id, mark]) => ({ id, status: mark.status, reason: mark.reason || '', pending: mark.pending || null, unanswered: mark.unanswered || [], lastCheckedAt: mark.lastCheckedAt })), events: this.events.slice(-30) };
  }
  async listContacts({ signal } = {}) { return this.browser.listContacts({ verifyFollowing: true, signal, preferredIds: this.policy.allowlist.map((item) => item.id) }); }
  async readConversation(id, { signal } = {}) {
    const policy = validatePolicy(load(this.policyFile, this.policy));
    if (!policy.allowlist.some((item) => item.id === id)) throw new Error('联系人不在已核对白名单，未读取私信。');
    return this.browser.readConversation(id, { allowed: true, signal });
  }
  async videoInspector() {
    // 私信和观看共用一个标签页/控制器时，直接用 watching 的那个，别再 new 第二个（会抢同一页）。
    const shared = this.browser?.controller;
    if (shared?.execute && typeof shared.close === 'function' && this.browser.sharedController) return shared;
    this.inspectorPromise??=import('./core.mjs?v=9').then(({BrowserController})=>new BrowserController({source:String(this.browser.controller?.source||'').startsWith('dsh')?'dsh':'api'}));
    return this.inspectorPromise;
  }
  // 2026-10-25 主人定：查到有分享视频时，先让推荐流的观看**暂停**，看完分享、回完消息再放它继续。
  // 复用 F9 那套 watch-hold.flag（watch 那边只认 .pid，进程还活着就算按住）。
  holdWatchForMedia() {
    try {
      fs.writeFileSync(path.join(this.stateDir, 'watch-hold.flag'), JSON.stringify({ pid: process.pid, source: 'chat', at: new Date().toISOString() }));
      this._mediaHold = true;
      this.log('watch.held_for_media', { message: '有分享视频，先暂停推荐流观看。' });
    } catch (error) { this.log('watch.hold_failed', { message: String(error?.message || error).slice(0, 120) }); }
  }
  releaseWatchHold() {
    try {
      const file = path.join(this.stateDir, 'watch-hold.flag');
      if (!fs.existsSync(file)) { this._mediaHold = false; return; }
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current?.pid !== process.pid) { this._mediaHold = false; return; }
      fs.unlinkSync(file);
      this._mediaHold = false;
      this.log('watch.resumed_after_media', { message: '分享视频处理完，推荐流继续。' });
    } catch { this._mediaHold = false; }
  }
  // 方案 B（2026-10-25 主人定）：采样帧一次性进模型，写一段「看片笔记」；正文回复只用这段文字，不再吃图片 token。
  async watchNotes({ context = [], sharedWork, frames = [], transcript = '', audioNote = '', danmaku = '', signal } = {}) {
    if (!frames.length) return '';
    const ask = {
      id: `notes:${Date.now()}`,
      sender: 'incoming',
      text: `【内部任务，不是对方说的话】你在看对方分享的一条视频${sharedWork?.title ? `（标题「${sharedWork.title}」）` : ''}，作者 ${sharedWork?.author || '未知'}。用不超过 80 字、第一人称、口语，像在跟主人说刚才看到的东西，写下你看到的和听到的；**只写一段话，不要 JSON、不要字段名、不要总结剧情**。有声音就描述声音的样子（有节奏、有语气词、只是没有人声，也算有声音）；完全没声音才说没有声音。不要写成回复对方的话，不要加“自动回复”。`,
    };
    // 2026-10-29 主人定：分享视频也带「打上时间的高赞弹幕」；弹幕是观众反应，不是画面事实。
    const note = [audioNote, transcript ? `录到的转写（可能有错字）：「${transcript}」` : '', danmaku ? `高赞弹幕（观众反应、可能玩梗，方括号是出现时间）：\n${danmaku.slice(0, 900)}` : ''].filter(Boolean).join('；') || '没有录音。';
    const observation = { messageId: ask.id, media: { type: 'shared-work', title: sharedWork?.title, author: sharedWork?.author }, frames: frames.slice(0, 12), note };
    const said = await this.agent.reply({ messages: [...context.slice(-4), ask], mediaObservations: [observation], signal });
    const text = String(said?.text || '').replace(/^\[自动回复\]\s*/, '').trim();
    this.log('message.watch_notes', { text: text.slice(0, 120) });
    return text.slice(0, 220);
  }
  // 2026-10-25：看到 50% 时问它自己还要不要看完。只回四个字以内的判断，回复正文不受影响。
  async watchVerdict({ context = [], sharedWork, frames = [], signal } = {}) {
    if (!frames.length) return 'leave';
    const question = {
      id: `verdict:${Date.now()}`,
      sender: 'incoming',
      text: `【内部判断，不是对方发来的话】上面这条分享视频我看到一半了（标题：${sharedWork?.title || '未知'}）。想不想看完？只回答「看完」或「退出」，不要写别的。`,
    };
    const messages = [...context.slice(-6), question];
    const observation = { messageId: question.id, media: { type: 'shared-work', title: sharedWork?.title, author: sharedWork?.author }, frames: frames.slice(0, 6), note: '这是从头到一半之间均匀取的几帧，不是整条作品。' };
    let text = '';
    try { text = String((await this.agent.reply({ messages, mediaObservations: [observation], signal }))?.text || ''); }
    catch (error) { this.log('message.watch_verdict_error', { message: String(error?.message || error).slice(0, 120) }); return 'leave'; }
    const wants = /看完|继续|想看|看完吧|不错|可以/.test(text) && !/退出|不看|算了|没意思/.test(text);
    const verdict = wants ? 'finish' : 'leave';
    this.log('message.watch_verdict', { verdict, text: text.slice(0, 60) });
    return verdict;
  }
  // 2026-10-25：视频工具有一条"自主观看在跑就别手动操作"的租约，私信这边没有 runId 会被直接拒
  // （实测 note：自主观看正在运行或需要清理残留）。私信读分享视频本来就该算这一轮的一部分，借用它的 runId。
  watchRunId() {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'watch-loop.lock'), 'utf8'));
      if (!Number.isSafeInteger(owner?.pid) || typeof owner?.runId !== 'string') return undefined;
      try { process.kill(owner.pid, 0); return owner.runId; } catch (error) { return error.code === 'EPERM' ? owner.runId : undefined; }
    } catch { return undefined; }
  }
  async observeMessage(id,messageId,{signal,includeWork=true,context=[]}={}) {
    const snapshot=await this.readConversation(id,{signal});
    // 2026-10-25：虚拟列表每次重读都会重排 id，按 id 找会直接"没有可识别的卡片"（实测 07:08:33）。
    // 找不到就退回"最后一条带媒体的 incoming 消息"，并改用这次读到的 id 继续。
    const all = messagesOf(snapshot);
    let message = all.find(item => item.id === messageId);
    if (!message?.media || message.unsupported) message = all.filter(item => item.sender === 'incoming' && item.media && item.unsupported !== true).at(-1) ?? message;
    if(!message?.media || message.unsupported) throw new Error('指定消息没有可识别的表情或作品卡片。');
    const resolvedMessageId = message.id;
    if(typeof this.browser.captureMessage!=='function') throw new Error('私信画面适配尚未加载，请重新加载插件。');
    const captured=await this.browser.captureMessage(id,resolvedMessageId,{allowed:true,signal});
    if(captured.loginRequired||captured.verificationRequired||!captured.frames?.length) throw new Error('没有取得指定消息的画面，请核对登录或验证。');
    const result={...captured,messageId:resolvedMessageId,frames:captured.frames.slice(0,1)};
    if(includeWork && message.media.type==='shared-work') {
      const inspector=await this.videoInspector();
      const limits=inspector.limits().state();
      if(!limits.allowed) {result.note=`当前只读取分享卡片封面和网页元数据，未播放作品：${limits.reason}`;return result;}
      try {
        const resolved=await this.browser.openSharedVideo(id,resolvedMessageId,{allowed:true,signal});
        result.sharedWork=resolved;
        this.log('message.observe_open', { opened: resolved.opened ?? null, source: resolved.source ?? null, videoId: resolved.videoId ?? null, url: resolved.url ?? null });
        if(!resolved.url) {result.note=resolved.reason||'分享作品链接未核实，只读取卡片。';return result;}
        if(resolved.isPhotoGallery===true) {
          // 2026-10-25 主人定：图文作品没有进度条，点进去以后录 10 秒音轨转写，就按"看完"处理，然后退出。
          let heard = '';
          try {
            const listened = await inspector.execute('douyin_listen', { seconds: 10 }, { signal, autonomousRunId: this.watchRunId() });
            heard = String(listened?.audio?.text || '').trim();
            if (!heard && listened?.audioAvailable === false) heard = '（音频开关没开，没录到声音）';
          } catch (error) { heard = `（录音没成功：${String(error?.message || error).slice(0, 40)}）`; }
          result.verdict = 'finish'; result.watchedToEnd = true;
          result.understandingScope = 'photo-gallery-with-ten-second-audio';
          result.note = `分享的是图文作品（没有进度条）：已录 10 秒声音${heard ? `，转写为「${heard.slice(0, 300)}」` : ''}，按看完了处理。`;
          await inspector.execute('douyin_pause', {}, { signal, autonomousRunId: this.watchRunId() }).catch(() => {});
          await inspector.withPage(async page => { await page.keyboard.press('Escape').catch(() => {}); }, { signal }).catch(() => {});
          return result;
        }
        // 2026-10-25 主人实测：点卡片是就地弹浮层、视频自动播放。先不动它，直接观察；
        // 只有当前页拿不到这条作品时才导航过去（导航没有用户手势，自动播放可能被拦）。
        let observed = await inspector.execute('douyin_observe',{seconds:WATCH_SAMPLE_SECONDS,frames:WATCH_SAMPLE_FRAMES},{signal, autonomousRunId: this.watchRunId()}).catch(() => null);
        if (observed?.state?.video?.id !== resolved.videoId) {
          await inspector.execute('douyin_open_video',{url:resolved.url},{signal, autonomousRunId: this.watchRunId()});
          await inspector.withPage(async page => page.evaluate(() => {
            const videos = [...document.querySelectorAll('video')].filter(v => v.readyState >= 2);
            videos.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            videos[0]?.play?.().catch(() => {});
          }), { signal, autonomousRunId: this.watchRunId() }).catch(() => {});
          observed = await inspector.execute('douyin_observe',{seconds:WATCH_SAMPLE_SECONDS,frames:WATCH_SAMPLE_FRAMES},{signal, autonomousRunId: this.watchRunId()});
        }
        if(observed.state?.video?.id!==resolved.videoId || observed.observation?.videoId!==resolved.videoId) {
          // 2026-10-26：以前只报一句“不一致”，查不出是卡片 ID 错、还是采样帧没记 ID。
          this.log('message.observe_mismatch', {
            resolvedId: resolved.videoId ?? null, source: resolved.source ?? null, url: resolved.url ?? null,
            stateId: observed?.state?.video?.id ?? null, frameId: observed?.observation?.videoId ?? null,
            frames: observed?.frames?.length ?? 0,
          });
          throw new Error('作品采样身份与分享消息不一致。');
        }
        // 2026-10-25：声音不再用阻塞式 douyin_listen——它录 8 秒的这 8 秒里截不了图，"每 5 秒采样"等于作废。
        // 改用推荐流那套**滚动采集**（独立进程，每 10 秒一段，和截图互不阻塞），最后从 rolling.txt 取本轮新增的转写。
        const rollingFile = path.join(this.stateDir, 'rolling', 'rolling.txt');
        const rollingStart = (() => { try { return fs.statSync(rollingFile).size; } catch { return 0; } })();
        const videoNow = observed.state?.video ?? {};
        const duration = Number(videoNow.duration) || 0;
        const shortClip = duration > 0 && duration <= 60;
        const cap = shortClip ? duration : (duration ? duration * 0.5 : 15);
        const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const samples = [];
        // 2026-10-29 主人定：分享视频跟推荐流共用同一套抽帧（2fps、原尺寸），看完拼 1–3 张故事板。
        const grabOn = await inspector.startFrameGrab?.(resolved.videoId).then(() => true).catch(() => false);
        let lastState = observed.state, lastTime = 0, sawWrap = false, lastSampleAt = 0;
        const sampleNow = async (seconds = 2) => {
          const seen = await inspector.execute('douyin_observe', { seconds }, { signal, autonomousRunId: this.watchRunId() }).catch(() => null);
          if (seen?.frames?.length) samples.push(...seen.frames.slice(0, 2));
          return seen;
        };
        // 抖音会自动重播：靠"进度倒退"判断播到结尾；墙钟上限 = 目标时长 + 20 秒，绝不空转。
        const wallStarted = Date.now();
        while (Date.now() - wallStarted < cap * 1000 + 20_000) {
          signal?.throwIfAborted();
          if (lastSampleAt) { const wait = 5_000 - (Date.now() - lastSampleAt); if (wait > 0) await sleepFor(wait); }
          let status;
          try { status = await inspector.execute('douyin_status', {}, { signal, autonomousRunId: this.watchRunId() }); } catch { break; }
          const state = status?.state ?? status;
          if (!state?.video) break;
          lastState = state;
          const time = Number(state.video.time) || 0;
          if (lastTime - time > 1) sawWrap = true;
          lastTime = time;
          if (sawWrap || time >= cap || (duration && time >= duration - 0.5)) { await sampleNow(2); break; }
          if (state.video.paused && time > 0) {
            if (Date.now() - wallStarted > 12_000) break;
            await inspector.withPage(async page => page.evaluate(() => { for (const v of document.querySelectorAll('video')) if (v.readyState >= 2) v.play?.().catch(() => {}); }), { signal }).catch(() => {});
            continue;
          }
          await sampleNow(2);
          lastSampleAt = Date.now();
        }
        // A（2026-10-25 主人定）：转写比画面晚 10~20 秒，读之前先等它追上——
        // 连续两次文件不再增长就算追上；最少等 6 秒、最多等 15 秒。
        const waitStarted = Date.now();
        let prevSize = -1, stableCount = 0, caughtUp = false;
        while (Date.now() - waitStarted < 15_000) {
          await sleepFor(1_000);
          let nowSize = 0;
          try { nowSize = fs.statSync(rollingFile).size; } catch { nowSize = 0; }
          if (nowSize > prevSize) stableCount = 0; else stableCount += 1;
          prevSize = nowSize;
          if (Date.now() - waitStarted >= 6_000 && stableCount >= 2) { caughtUp = true; break; }
        }
        // 滚动采集在这一段时间里转写出来的台词（只取本轮新增）
        let heard = '';
        try {
          const size = fs.statSync(rollingFile).size;
          if (size > rollingStart) {
            const length = Math.min(size - rollingStart, 4096);
            const buf = Buffer.alloc(length);
            const fd = fs.openSync(rollingFile, 'r');
            try { fs.readSync(fd, buf, 0, length, size - length); } finally { fs.closeSync(fd); }
            heard = buf.toString('utf8').trim();
          }
        } catch { /* 没有滚动转写就算了 */ }
        const audioNote = heard
          ? `滚动转写（每 10 秒一段）${caughtUp ? '' : '，转写没追上、最后几秒可能缺失'}：${heard.slice(-500)}`
          : '（这一轮没有滚动转写，可能没在观看轮次里）';


        if (shortClip) { result.watchedToEnd = true; result.verdict = 'finish'; }
        else {
          // 2026-10-28 主人定：分享视频跟推荐流一样——采样那几张决定看不看，中途不再问一次，
          // 直接看到结尾（最多等 90 秒），看完只回一条。
          const verdict = 'finish';
          result.verdict = verdict;
          if (verdict === 'finish') {
            const until = Date.now() + Math.min(90_000, duration ? duration * 1000 + 15_000 : 90_000);
            let finLast = 0, finWrap = false;
            while (Date.now() < until) {
              await sleepFor(3_000);
              signal?.throwIfAborted();
              let status;
              try { status = await inspector.execute('douyin_status', {}, { signal, autonomousRunId: this.watchRunId() }); } catch { break; }
              const state = status?.state ?? status;
              if (!state?.video) break;
              lastState = state;
              const time = Number(state.video.time) || 0;
              if (finLast - time > 1) finWrap = true;
              finLast = time;
              // 2026-10-28 主人定：分享的长片跟推荐流一致，3 分钟以上看到 80% 就算看完。
              const longEnough = Number.isFinite(duration) && duration > 180;
              if (finWrap || (duration && time >= duration - 0.5) || (longEnough && time >= duration * 0.8)) break;
              await sampleNow(2);
            }
            result.watchedToEnd = true;
          }
        }
        // 结尾先暂停再补一张，避免采到自动重播的第一帧。
        await inspector.execute('douyin_pause', {}, { signal, autonomousRunId: this.watchRunId() }).catch(() => {});
        const tailObs = await inspector.execute('douyin_observe', { seconds: 2 }, { signal, autonomousRunId: this.watchRunId() }).catch(() => null);
        if (tailObs?.frames?.length) samples.push(...tailObs.frames.slice(0, 2));
        if (tailObs?.state) lastState = tailObs.state;
        // 看片笔记：所有采样帧一次性交给模型，写一段过程描述；之后的回复只用这段文字。
        // 2026-10-28 主人定：私信也改用拼图，上限跟推荐流一致——每张最多 6 格、最多 14 张，
        // 拼不起来才退回原来的原图（最多 12 张）。
        let noteFrames = samples.length <= 12 ? samples : Array.from({ length: 12 }, (_, i) => samples[Math.round(i * (samples.length - 1) / 11)]);
        // 2026-10-29：先用抽帧故事板（最多 3 张、每张 9–16 格）；拼不出来再退回原来的分组拼图。
        let storyboard = null, danmakuText = '';
        if (grabOn) {
          try {
            const board = await inspector.composeStoryboard(resolved.videoId, { duration: duration || null, maxSheets: 3, signal });
            if (board?.sheets?.length) storyboard = board.sheets;
          } catch { /* 退回原图 */ }
        }
        try {
          const danmaku = await inspector.danmakuFor(resolved.videoId, { limit: 20, duration: duration || null });
          danmakuText = danmaku.text || '';
        } catch { /* 没弹幕就算了 */ }
        try {
          const groups = Math.min(14, Math.ceil(samples.length / 6));
          const picked = [];
          for (let g = 0; g < groups; g++) {
            const start = Math.floor((g * samples.length) / groups);
            const end = Math.floor(((g + 1) * samples.length) / groups);
            const slice = samples.slice(start, Math.max(end, start + 2)).slice(0, 6);
            if (slice.length < 2) continue;
            const composite = await inspector.composeFrames(slice, { columns: 3, cellHeight: 0, cropRightPx: 90, cropBottomPx: 220, signal }).catch(() => null);
            if (composite?.data) picked.push(composite);
          }
          if (picked.length >= 1) noteFrames = picked;
        } catch { /* 拼不起来就退回原图 */ }
        if (storyboard?.length) noteFrames = storyboard;
        const notes = await this.watchNotes({ context, sharedWork: resolved, frames: noteFrames, transcript: heard.slice(0, 600), audioNote, danmaku: danmakuText, signal }).catch(() => '');
        result.watchNotes = notes;
        result.frames = [];
        result.note = `${notes ? `看片笔记：${notes}` : '（这次没写下看片笔记，只拿到卡片）'}${heard ? ` 听到的：${heard.slice(0, 400)}` : '（没录到声音）'}`;
        if (audioNote) result.note += ` ${audioNote.slice(0, 300)}`;
        // 2026-10-25：state 很大（视频+视口+可见文字），塞进 sharedWork 会把后面的 note 挤出 2500 字预算。
        result.sharedWork = { opened: resolved.opened, videoId: resolved.videoId, url: resolved.url, source: resolved.source, isPhotoGallery: resolved.isPhotoGallery };
        result.understandingScope = result.watchedToEnd ? 'card-cover-and-watched-to-end-video-sampling' : 'card-cover-and-played-to-half-video-sampling';
        await inspector.execute('douyin_pause',{}, {signal, autonomousRunId: this.watchRunId()});
        // 2026-10-25 主人实测：**按 ESC 直接退回刚才那条推荐流视频**（进度都在）。
        // 以前调 douyin_open 会重新拉一条推荐，原来看到哪儿全丢。
        await inspector.withPage(async page => { await page.keyboard.press('Escape').catch(() => {}); }, { signal }).catch(() => {});
      }catch(error) {signal?.throwIfAborted();result.note=`分享卡片已读取，作品观察未完成：${redact(error.message,[this.config.apiKey])}`;
        // 2026-10-25：这里原来会调 pauseForLimits() 把页面里所有 video 暂停，主人看到的「点开播一下就停」就是它。
        // 观察失败不该动播放状态——要停也是观看轮自己停。
      }
    }
    // 2026-10-25：重读会重新分配消息 id，但调用方的 incoming 用的还是旧 id。
    // 这里换回调用方给的那个 id，否则 ChatAgent 会判「媒体画面不属于本次待回复消息」（实测 07:21:52）。
    result.messageId = messageId;
    return result;
  }

  async configure({ recipientIds, aliases, dailyReplyLimit = this.policy.dailyReplyLimit } = {}) {
    if (this.running || this.starting || this.busy || this.worker()?.alive) throw new Error('请先停止私信自动回复，再修改白名单或预算。');
    if (!Array.isArray(recipientIds) || recipientIds.length > 10 || recipientIds.some((id) => typeof id !== 'string')) throw new Error('请选择最多十个已关注联系人。');
    const result = await this.browser.listContacts({ verifyFollowing: true, preferredIds: this.policy.allowlist.map((item) => item.id) });
    if (result.blocked || result.loginRequired || result.verificationRequired) throw new Error('请在专用 Edge 完成登录或验证。');
    // 备注是主人手填的称呼；没填就沿用上一次保存的值（重选联系人不会把备注清空）。
    if (aliases !== undefined && (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases))) throw new Error('备注格式无效。');
    const previousAlias = new Map(this.policy.allowlist.map((item) => [item.id, typeof item.alias === 'string' ? item.alias : '']));
    const allowlist = recipientIds.map((id) => {
      const contact = result.contacts?.find((item) => item.id === id);
      if (!contact || contact.followed !== true || contact.isGroup !== false) throw new Error('所选联系人尚未核对为已关注的个人联系人。');
      const alias = String((aliases && aliases[id]) ?? previousAlias.get(id) ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 30);
      return { id, name: contact.name || contact.displayName || '联系人', alias, followed: true, isGroup: false, verifiedAt: new Date().toISOString(), relationshipEvidence: contact.relationshipEvidence || '浏览器关系回读' };
    });
    const policy = validatePolicy({ version: 1, enabled: false, allowlist, dailyReplyLimit });
    this.acquire();
    try { this.control(() => { this.assertOwned(); this.policy = policy; save(this.policyFile, this.policy); }); this.log('policy.updated', { recipientIds, dailyReplyLimit }); }
    finally { this.release(); }
    return this.state();
  }

  async start({ schedule = true, signal } = {}) {
    signal?.throwIfAborted();
    if (this.running) return this.state();
    if (this.starting) return this.starting;
    this.starting = this.begin(schedule, signal);
    try { return await this.starting; } finally { this.starting = null; if (!this.running) this.release(); }
  }
  setReplyProvider(provider) {
    if (provider !== undefined && typeof provider !== 'function') throw new TypeError('私信回复提供器必须是本机函数。');
    if (this.running || this.starting || this.busy) throw new Error('请先停止私信自动回复，再修改回复提供器。');
    this.agent.replyProvider = provider;
  }
  async begin(schedule, externalSignal) {
    if (!this.config?.apiKey && typeof this.agent.replyProvider !== 'function') throw new Error('没有找到 DeepSeek API Key。');
    this.acquire();
    this.policy = validatePolicy(load(this.policyFile, this.policy));
    if (!this.policy.allowlist.length) throw new Error('请先保存核对后的白名单。');
    this.abort = new AbortController();
    const externalAbort = () => this.abort.abort(externalSignal.reason || new Error('启动任务已停止。'));
    if (externalSignal?.aborted) externalAbort(); else externalSignal?.addEventListener('abort', externalAbort, { once: true });
    // 2026-10-25：开轮读白名单会话时也一样，读完全部只关一次门。
    this.browser.holdPanel?.();
    const signal = this.abort.signal;
    try {
      // 2026-10-25 主人定：开轮别再去主页「关注」弹层核对一遍（那一跳又慢又容易被半渲染坑到）。
      // 白名单是保存时核对过的，这里只读会话列表，找不到就按昵称兜底。
      const contacts = await this.browser.listContacts({ signal, verifyFollowing: false, preferredIds: this.policy.allowlist.map((item) => item.id) }); signal.throwIfAborted();
      if (contacts.blocked || contacts.loginRequired || contacts.verificationRequired) throw new Error('抖音私信页面需要手动处理。');
      let readyContacts = 0;
      for (const contact of this.policy.allowlist) {
        // 2026-10-24：按 id 找不到就按昵称兜底（头像/签名变化会让 id 变）；关注关系只在「明确取关」时拒绝，
        // 取不到（null）就沿用保存白名单时的核对记录，不再每次启动都重判一次。
        const current = contacts.contacts?.find((item) => item.id === contact.id) || contacts.contacts?.find((item) => item.displayName === contact.name);
        // 列表偶尔只渲染出一部分（实测先出 uid 后出昵称）：这一位先跳过，别把整次启动判死。
        if (!current) { this.log('contact.missing', { recipientId: contact.id, name: contact.name }); continue; }
        if (current.isGroup === true) { this.log('contact.group', { recipientId: contact.id }); continue; }
        if (current.followed === false) { this.log('contact.unfollowed', { recipientId: contact.id }); continue; }
        const old = this.watermarks.contacts[contact.id];
        // 2026-10-24：发送未确认不再阻止启动——下面反正会重建基线（不带 pending），
        // 由 poll 的下一次核对决定“已发/重来”，不再要求人工点“已人工核对”。
        if (['inflight', 'delivery-uncertain'].includes(old?.status)) this.log('contact.reset_uncertain', { recipientId: contact.id, status: old.status });
        const snapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
        const messages = messagesOf(snapshot);
        if ((snapshot.contact?.id || snapshot.conversation?.id) !== contact.id) throw new Error('私信会话身份回读不一致，未启用。');
        const unanswered = [...(old?.unanswered || [])];
        // 2026-10-24 主人定：可以补发历史消息。基线**只记我自己发出的消息**，
        // 对方发来的全部当未回处理（之前按“最后一条发出”截断，实测会把最新那条也吞进 seen，变成已读不回）。
        const baseline = messages.filter((item) => item.sender === 'outgoing').map((item) => item.id);
        // 2026-10-24 21:40：光记住「没回」不够——poll 会把这些消息判成 known-old-window 直接跳过，
        // 于是主人看到的是「打开看了消息、换下一个、就是不回」。这里先认下待补发的最后几条。
        const catchup = this.catchupMessages(messages);
        this.watermarks.contacts[contact.id] = { status: 'ready', seen: baseline.slice(-2000), context: [], unanswered: unanswered.slice(-60), catchup: catchup.length > 0, catchupTries: 0, startedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() };
        if (catchup.length) this.log('message.catchup_pending', { recipientId: contact.id, count: catchup.length, last: catchup.at(-1)?.text || '' });
        readyContacts += 1;
      }
      if (!readyContacts) throw new Error('白名单联系人在当前会话列表里一个都没找到，未启用自动回复。');
      this.persist(); signal.throwIfAborted();
      this.control(() => { this.assertOwned(); this.policy.enabled = true; save(this.policyFile, this.policy); save(this.lockFile, { pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: 'running' }); }); this.running = true;
      this.log('service.started', { message: '已建立现有消息基线：先补回对方最后几条没回的，之后继续回新消息。' });
      if (schedule) {
        const tick = () => void this.poll().catch((error) => this.log('poll.error', { message: String(error?.message || error).slice(0, 160) }));
        // 2026-10-25：原来第一次轮询要等满 30 秒，主人开一轮十几秒就停，补发一次都轮不到。
        // 现在起来 2 秒就先跑一次（开轮那次全量核对之后立刻把没回的回掉）。
        this.kickoff = setTimeout(tick, 500); this.kickoff.unref?.();
        this.timer = setInterval(tick, this.pollIntervalMs); this.timer.unref?.();
      }
      return this.state();
    } catch (error) { this.running = false; this.policy.enabled = false; this.log('service.start_failed', { message: error.message }); throw error; }
    finally {
      externalSignal?.removeEventListener('abort', externalAbort);
      this.browser.releasePanel?.();
      try { await this.browser.closePanel?.(); } catch { /* 关不上不影响结果 */ }
    }
  }
  stop() {
    if (this.ownershipLost) return this.state();
    const worker = this.worker();
    if (this.runId && worker?.owned !== true) { this.loseOwnership(); return this.state(); }
    if (worker?.alive && !worker.owned) {
      if (!worker.runId) throw new Error('另一个入口正在取得锁，请稍后停止。');
      save(this.stopFile, { targetRunId: worker.runId, requestId: randomUUID(), requestedAt: new Date().toISOString() });
      return { ...this.state(), stopping: true, message: '已向当前回复进程发送停止请求。' };
    }
    this.running = false; clearInterval(this.timer); this.timer = null; clearTimeout(this.kickoff); this.kickoff = null; if (this._mediaHold) this.releaseWatchHold(); this.abort?.abort(new Error('用户停止私信自动回复。')); this.policy.enabled = false; this.log('service.stopped'); this.release(); return this.state();
  }
  resumeContact(id) {
    if (this.running || this.starting || this.busy || this.worker()?.alive) throw new Error('请先停止自动回复，再人工解除联系人暂停。');
    this.acquire();
    try { this.control(() => { this.assertOwned(); this.policy = validatePolicy(load(this.policyFile, this.policy)); this.watermarks = load(this.watermarkFile, this.watermarks);
      if (!this.policy.allowlist.some((item) => item.id === id)) throw new Error('联系人不在白名单。');
      const mark = this.watermarks.contacts[id]; if (mark) { mark.status = 'ready'; mark.reason = ''; this.persist(); }
    }); this.log('contact.manually_resolved', { recipientId: id, message: '用户确认已核对发送结果；下次启动将重新建立基线，不重发旧消息。' }); }
    finally { this.release(); }
    return this.state();
  }

  async deliverReply(contact, mark, reply, latest, signal, { followUp = false } = {}) {
    const expectedContent = latest.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
    let entered = false, delivery;
    try {
      delivery = await this.outbound.run({ recipientId: contact.id, purpose: 'reply', signal }, async () => {
        signal.throwIfAborted(); this.assertOwned();
        const current = await this.browser.readConversation(contact.id, { allowed: true, signal });
        const messages = messagesOf(current);
        // 2026-10-24 21:45：不再逐条比对 id——抖音消息行没有稳定原生 id，同一句重复时每次读都会重排 id，
        // 之前这条判断把每一次发送都判成 superseded。现在只守身份：会话对、没有方向不明、对方仍是最后说话的人。
        const speakLast = messages.at(-1)?.sender;
        if ((current.contact?.id || current.conversation?.id) !== contact.id || messages.some(item => item.sender === 'unknown') || (speakLast === 'outgoing' && !followUp)) {
          mark.pending.phase = 'superseded'; this.persist();
          return { confirmed: false, deliveryUncertain: false, superseded: true };
        }
        entered = true; mark.status = 'inflight'; mark.pending = { ...mark.pending, phase: 'sending', text: reply.text, at: new Date().toISOString() }; this.persist();
        return this.browser.sendMessage(contact.id, reply.text, { allowed: true, signal, expectedMessageIds: latest.map(item => item.id), expectedMessageContent: expectedContent, followUp });
      });
    } catch (error) {
      if (!entered && error.beforeDelivery && error.code === 'OUTBOUND_BUSY') {
        mark.status = 'ready'; mark.pending = { ...mark.pending, phase: 'outbound-wait', generatedText: reply.text, expectedContent, usage: reply.usage, at: new Date().toISOString() }; this.persist(); this.log('reply.waiting_for_sender', { recipientId: contact.id }); return;
      }
      if (!entered) throw error;
      mark.status = 'delivery-uncertain'; mark.reason = '发送中断或失败，需人工核对；不会自动重发。'; this.persist(); this.log('delivery.uncertain', { recipientId: contact.id, message: error.message }); return;
    }
    if (delivery?.superseded) { this.log('reply.superseded', { recipientId: contact.id }); return; }
    if (delivery?.confirmed !== true || typeof delivery.messageId !== 'string' || !delivery.messageId.trim()) { mark.status = 'delivery-uncertain'; mark.reason = '未取得发送确认，需人工核对；不会自动重发。'; this.persist(); this.log('delivery.uncertain', { recipientId: contact.id, confirmed: delivery?.confirmed, messageId: delivery?.messageId || null, reason: delivery?.reason || null }); return; }
    mark.status = 'ready'; mark.reason = ''; mark.context.push({ id: delivery.messageId, sender: 'outgoing', text: reply.text }); mark.context = mark.context.slice(-12);
    mark.seen.push(delivery.messageId); delete mark.pending; this.persist();
    this.log('reply.sent', { recipientId: contact.id, text: reply.text, messageId: delivery.messageId, usage: reply.usage });
  }
  // 会话末尾「我说完就没了」的部分就是没回的：取最后一条我自己发的之后的对方消息。
  // 只认今天能看出来的时间（刚刚 / N分钟前 / N小时前 / 今天 / HH:MM），久远历史不追，避免突然回一句几个月前的。
  catchupMessages(messages) {
    const lastOutgoing = messages.findLastIndex((item) => item.sender === 'outgoing');
    const tail = messages.slice(lastOutgoing + 1).filter((item) => item.sender === 'incoming' && item.unsupported !== true);
    if (!tail.length) return [];
    const raw = String(tail.at(-1)?.dateEvidence?.raw ?? tail.at(-1)?.sentAt ?? tail.at(-1)?.timestamp ?? '').trim();
    // 2026-10-25：以前只认「刚刚/N分钟前/今天/昨天/HH:MM」，读不到时间标记（空串）就直接放弃——
    // 微光那条「滴滴滴」就是这么漏的。现在反过来：只有明确是旧日期的才不补，其余一律补。
    const looksOld = /^\d{4}[-/年]|\d{1,2}\s*月\s*\d{1,2}\s*日|\d+\s*(?:天|周|个月|年)前|星期[一二三四五六日天]|^\d{1,2}-\d{1,2}$/.test(raw);
    return looksOld ? [] : tail;
  }
  async poll() {
    if (!this.running || this.busy) { this.log('poll.skip', { running: this.running, busy: this.busy }); return; }
    this.assertOwned();
    this.log('poll.tick', { at: new Date().toISOString() });
    this.busy = true; const signal = this.abort.signal;
    // 2026-10-25：整段轮询期间面板只开一次，别每读一次会话就关一次门（主人看到的就是反复拉开又关掉）。
    this.browser.holdPanel?.();
    // 2026-10-25 23:25 主人：有角标就只读有未读的那个会话，别把白名单挨个读一遍。
    // 2026-10-24 的回退（永远 null）是因为「列表半渲染时读不到角标 → 已读不回」；
    // 现在只在行确实渲染出来时才敢跳过，行没出现就当未知、照旧读（见 planUnreadFilter）。
    let unreadIds = null;
    const mustRead = Object.entries(this.watermarks.contacts || {})
      .filter(([, mark]) => ['delivery-uncertain', 'inflight'].includes(mark?.status) || mark?.pending?.phase === 'outbound-wait' || mark?.catchup === true)
      .map(([id]) => id);
    try {
      // 2026-10-25 主人定：轮询先看右上角「消息」红数字，是 0 就整轮不开面板；开轮时 begin() 的全量核对不受影响，
      // 「手机上看了没回」那种没有红点的情况由开轮那次补上。有未确认发送/待发内容的联系人时必须照旧读，否则没法定夺。
      // 有待补发的联系人也不能跳过：没有红点（手机上读过）但末尾还有没回的消息，就靠这一轮补。
      const needsRead = Object.values(this.watermarks.contacts).some((item) => ['delivery-uncertain', 'inflight'].includes(item?.status) || item?.pending?.phase === 'outbound-wait' || item?.catchup === true);
      if (!needsRead) {
        let badge = null;
        try { badge = await this.browser.unreadCount(); } catch { badge = null; }
        if (badge?.ok === true && badge.count === 0) { this.log('poll.skipped_no_badge', { message: '右上角消息没有红点，这一轮不打开私信面板。' }); return; }
      }
      // 2026-10-25：面板反正要开，开的时候顺手读一次会话列表，按每一行自己的小红点决定要不要进这个会话。
      try {
        const listed = await this.browser.listContacts({ signal, verifyFollowing: false, preferredIds: this.policy.allowlist.map((item) => item.id) });
        const rows = Array.isArray(listed?.contacts) ? listed.contacts : [];
        if (!listed?.blocked && rows.length) {
          const plan = planUnreadFilter({ rows, allowlist: this.policy.allowlist, mustRead });
          unreadIds = plan.unread;
          this.log('poll.unread_rows', { rows: plan.rows, read: plan.unread.size, missing: plan.missing.length });
          if (!plan.anyWhitelist) {
            try { this.browser.releasePanel?.(); await this.browser.closePanel?.(); } catch { /* 关不上不影响这一轮跳过 */ }
            this.log('poll.no_whitelist_unread', { message: '红点都不在白名单会话上，这一轮不逐个读。' });
            return;
          }
        }
      } catch (error) {
        unreadIds = null;
        this.log('poll.unread_rows_failed', { message: String(error?.message || error).slice(0, 120) });
      }
      for (const contact of this.policy.allowlist) {
        signal.throwIfAborted(); this.assertOwned(); const mark = this.watermarks.contacts[contact.id];
        // 2026-10-24 主人定：发送未确认不再等人点「已人工核对」，下一次轮询自己核对：
        // 会话里找到刚发的那条就算已发，找不到就清掉标记、下一次重新回。
        if (mark && mark.status === 'delivery-uncertain') {
          try {
            const check = await this.browser.readConversation(contact.id, { allowed: true, signal });
            const seenMessages = messagesOf(check);
            const wanted = String(mark.pending?.generatedText || '').replace(/\s+/g, '');
            const delivered = Boolean(wanted) && seenMessages.some((item) => item.sender === 'outgoing' && String(item.text || '').replace(/\s+/g, '') === wanted);
            mark.status = 'ready'; mark.reason = '';
            if (delivered) { mark.seen = [...new Set([...(mark.seen || []), ...seenMessages.map((item) => item.id)])].slice(-2000); }
            delete mark.pending; mark.lastCheckedAt = new Date().toISOString(); this.persist();
            this.log(delivered ? 'delivery.confirmed_auto' : 'delivery.cleared_auto', { recipientId: contact.id });
          } catch (error) { this.log('delivery.check_failed', { recipientId: contact.id, message: String(error?.message || error).slice(0, 120) }); }
          continue;
        }
        if (!mark || mark.status !== 'ready') continue;
        // 没有未读角标就不开会话；只更新检查时间（2026-10-24）。
        if (unreadIds && !unreadIds.has(contact.id)) { mark.lastCheckedAt = new Date().toISOString(); continue; }
        try {
          const snapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
          if ((snapshot.contact?.id || snapshot.conversation?.id) !== contact.id) throw new Error('会话身份回读不一致。');
          if (mark.pending?.phase === 'outbound-wait') {
            const latest = messagesOf(snapshot), content = latest.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
            if (JSON.stringify(content) === JSON.stringify(mark.pending.expectedContent)) {
              await this.deliverReply(contact, mark, { text: mark.pending.generatedText, usage: mark.pending.usage }, latest, signal); continue;
            }
            // 2026-10-24 主人定：只是对方又追加了新消息就继续发（把新消息纳入上下文），
            // 只有旧消息被撤/顺序变了才放弃——之前一律 superseded，看起来就是“已读不回”。
            const expected = Array.isArray(mark.pending.expectedContent) ? mark.pending.expectedContent : [];
            const stillPrefix = expected.length <= content.length && expected.every((item, index) => content[index] && content[index].id === item.id);
            const appendedIncoming = stillPrefix && latest.slice(expected.length).every((item) => item.sender === 'incoming');
            if (appendedIncoming) {
              mark.pending.expectedContent = content;
              this.persist();
              await this.deliverReply(contact, mark, { text: mark.pending.generatedText, usage: mark.pending.usage }, latest, signal); continue;
            }
            mark.pending.phase = 'superseded'; this.persist();
          }
          const messages = messagesOf(snapshot); const seen = new Set(mark.seen);
          const discovered = messages.filter((item) => !seen.has(item.id));
          const oldHistory = discovered.filter((item) => ['baseline', 'known-old-window', 'old-history'].includes(item.arrivalClassification));
          const fresh = discovered.filter((item) => !oldHistory.includes(item));
          // 2026-10-24 21:40 主人报「打开看了信息、换下一个、就是不回」：启动前收到的消息全被判成历史跳过。
          // 白名单必回 → 末尾那几条没回的补一次（最多两次，失败不无限重试）。
          // 2026-10-26 20:10：原来是「一条 incoming 都没有」才补发；现在是「没有一条 incoming 有资格」就补发，
          // 否则服务关着时来的消息永远进不了补发分支，只能被暂停。
          if (mark.catchup && (mark.catchupTries || 0) < 2 && !fresh.some((item) => item.sender === 'incoming' && item.eligibleForReply === true)) {
            const catchup = this.catchupMessages(messages).map((item) => ({ ...item, catchup: true }));
            if (catchup.length) {
              fresh.push(...catchup);
              mark.catchupTries = (mark.catchupTries || 0) + 1;
              this.log('message.catchup_reply', { recipientId: contact.id, count: catchup.length, last: catchup.at(-1)?.text || '' });
            }
          }
          if (fresh.some((item) => item.sender === 'unknown')) { mark.pending = { phase: 'unclassified', incoming: fresh.map((item) => ({ id: item.id, sender: item.sender, text: item.text || '' })), at: new Date().toISOString() }; throw new Error('新消息方向未确认，联系人已暂停，消息未计入已处理水位。'); }
          mark.seen = [...seen, ...discovered.map((item) => item.id)].slice(-2000); mark.lastCheckedAt = new Date().toISOString(); this.persist();
          this.log('poll.messages', { recipientId: contact.id, total: messages.length, discovered: discovered.length, incoming: discovered.filter(item => item.sender === 'incoming').length, fresh: fresh.length });
          if (oldHistory.length) this.log('message.old_history_skipped', { recipientId: contact.id, messageIds: oldHistory.map((item) => item.id), message: '已知旧窗口或加载的历史行只更新水位，不回复。' });
          if (!fresh.length) continue;
          const supported=item=>item.unsupported!==true && (item.media && ['emoji','shared-work'].includes(item.media.type) || (!item.kind||item.kind==='text') && (!item.type||item.type==='text') && typeof item.text==='string' && item.text.trim());
          const unsupported = fresh.filter((item) => item.sender === 'incoming' && !supported(item));
          if (unsupported.length) this.log('message.unsupported', { recipientId: contact.id, messageIds: unsupported.map((item) => item.id), message: '图片、语音、撤回等非文本消息未理解，已跳过。' });
          mark.context = [...mark.context, ...fresh.filter((item) => ['incoming', 'outgoing'].includes(item.sender) && !unsupported.includes(item) && supported(item))].slice(-12); this.persist();
          const incoming = fresh.filter((item) => item.sender === 'incoming' && !unsupported.includes(item));
          if (!incoming.length) { if (fresh.some((item) => item.sender === 'outgoing') && mark.pending?.phase === 'superseded') { mark.pending.phase = 'handled-by-user'; this.persist(); this.log('reply.handled_by_user', { recipientId: contact.id }); } continue; }
          // 2026-10-26 20:10 主人定：观看过程中私信要一直能回。服务关着时进来的消息在追踪器里不是 new-tail，
          // 旧逻辑直接把联系人暂停（「只已读不回」就是这么来的）。现在只回「有资格」或「启动补发」的那几条，
          // 更早的历史行只更新水位、不回复，也不暂停。
          const answerable = incoming.filter((item) => item.eligibleForReply === true || item.catchup === true);
          if (!answerable.length) { mark.pending = { phase: 'unqualified', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; this.persist(); continue; }
          incoming.splice(0, incoming.length, ...answerable);
          const lastIncoming = messages.findLastIndex((item) => incoming.some((freshItem) => freshItem.id === item.id));
          if (messages.slice(lastIncoming + 1).some((item) => item.sender === 'outgoing')) { this.log('message.handled_by_user', { recipientId: contact.id, messageIds: incoming.map((item) => item.id) }); mark.pending = { phase: 'handled-by-user', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; this.persist(); continue; }
          const date = dayKey();
          if ((this.watermarks.days[date] ?? 0) >= this.policy.dailyReplyLimit) { mark.status = 'budget-paused'; mark.reason = '已达到每日模型请求上限；旧消息不自动补发。'; mark.pending = { phase: 'budget', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; this.persist(); this.log('budget.reached', { recipientId: contact.id }); continue; }
          const mediaObservations=[];
          const mediaItems = incoming.filter(item => item.media);
          if (mediaItems.length) this.holdWatchForMedia();
          // 2026-10-26 主人定：分享视频**不再先回一条 ack**——先点开看完，再只回一条。
          // 图文（文字+视频一起发）也一样：先看视频，回复里带上对方那段文字。
          if (mediaItems.length) { mark.pending = { phase: 'observing', incoming: incoming.map((item) => ({ id: item.id, text: item.text, kind: item.kind, media: item.media })), at: new Date().toISOString() }; this.persist(); }
          // 2026-10-26 回归：整段 hold 面板会让 openSharedVideo 里的 restorePage 不生效，私信面板盖着视频弹层，
          // 采样读到的是别的视频 → 「作品采样身份与分享消息不一致」。看分享视频这一段先放开门禁，让它照旧关面板。
          if (mediaItems.length) this.browser.releasePanel?.();
          for(const item of mediaItems) {
            if(mediaObservations.reduce((count,entry)=>count+entry.frames.length,0)>=4) throw new Error('同时收到的媒体消息超过本次四张采样预算，联系人已暂停，请人工查看。');
            const observed=await this.observeMessage(contact.id,item.id,{signal,context:mark.context});
            // 2026-10-25：观察到底看到了什么、为什么没播，必须留痕，否则只能从模型的回复里猜。
            this.log('message.media_observed', { scope: observed.understandingScope || null, verdict: observed.verdict || null, frames: observed.frames?.length ?? 0, note: String(observed.note || '').slice(0, 140) });
            const remaining=4-mediaObservations.reduce((count,entry)=>count+entry.frames.length,0);
            mediaObservations.push({...observed,frames:observed.frames.slice(0,remaining)});
          }
          if (mediaItems.length) this.browser.holdPanel?.();
          this.watermarks.days[date] = (this.watermarks.days[date] ?? 0) + 1;
          mark.pending = { phase: 'model', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; this.persist();
          this.log('message.received', { recipientId: contact.id, messages: incoming.map((item) => ({ id: item.id, text: item.text })) });
          // 已经回过一条时，第二次生成要把"刚回过的消息"也算进上下文，否则不满足"最后一条是对方发的"。
          const replyMessages = mark.context;
          const reply = await this.agent.reply({ messages: replyMessages, mediaObservations, signal, contact: { id: contact.id, name: contact.name, alias: contact.alias || '' } }); signal.throwIfAborted();
          mark.pending.generatedText = reply.text; this.persist();
          // 生成期间若用户已经回复，或对方又发消息，跳过本次发送。
          const latestSnapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
          if ((latestSnapshot.contact?.id || latestSnapshot.conversation?.id) !== contact.id) throw new Error('发送前会话身份回读不一致。');
          const latest = messagesOf(latestSnapshot);
          // 2026-10-24 21:45：按 id 找「待回消息还在不在」会因虚拟列表重排而误判，改成按内容指纹确认仍然存在。
          // 已发过 ack 时，会话最后一条本来就是我方消息、封面链接签名也会变——这两个判据只对“第一次回复”成立。
          // 2026-10-25 20:40：ack 发过但没确认时按「已经说过话」处理——最后一条是我方属正常，
          // 否则补发的正文回复会被这条判据顶掉（superseded），变成「看了也不回」。
          if (latest.some((item) => item.sender === 'unknown') || (latest.at(-1)?.sender === 'outgoing' || incoming.some((item) => !latest.some((current) => current.sender === 'incoming' && messageFingerprint(current) === messageFingerprint(item))))) { mark.pending.phase = 'superseded'; mark.pending.readback = latest.filter((item) => incoming.some((before) => messageFingerprint(before) === messageFingerprint(item))).map((item) => ({ id: item.id, sender: item.sender, kind: item.kind, text: item.text })); throw new Error('待回复消息在生成期间被撤回、改动或方向不明，未发送。'); }
          // 2026-10-24 主人定：白名单用户必回，所以“生成期间又来了新消息”不再作为放弃发送的理由
          // （撤回/改动/方向不明仍然在第 350 行拦着）。
          await this.deliverReply(contact, mark, reply, latest, signal);
          // 补发成功（pending 已被清掉）就收工；失败两次也不再挂着，免得红点门控一直为此开面板。
          if (mark.catchup && (!mark.pending || (mark.catchupTries || 0) >= 2)) { mark.catchup = false; this.persist(); }
        } catch (error) {
          if (mark.status === 'inflight') { mark.status = 'delivery-uncertain'; mark.reason = '发送被中断，需要人工核对。'; }
          else { mark.status = 'paused'; mark.reason = signal.aborted ? '用户停止时有未答消息，已保留在本机，未发送。' : redact(error.message, [this.config?.apiKey]); if (signal.aborted && mark.pending) mark.pending.phase = 'stopped-before-send'; }
          this.persist(); if (!signal.aborted) this.log('contact.paused', { recipientId: contact.id, message: mark.reason });
        }
      }
    } finally {
      this.busy = false;
      this.browser.releasePanel?.();
      try { await this.browser.closePanel?.(); } catch { /* 关不上不影响结果 */ }
      if (this._mediaHold) this.releaseWatchHold();
      if (!this.running) this.release();
    }
  }
  async close() { if (this.runId) this.stop(); while (this.busy || this.starting) await new Promise((resolve) => setTimeout(resolve, 20)); await this.browser.close?.(); if(this.inspectorPromise) await this.inspectorPromise.then(inspector=>inspector.close()).catch(()=>{}); }
}
