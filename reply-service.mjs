import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { BrowserController } from './core.mjs?v=9';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { AutonomousReplies } from './autonomous-replies.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const vid = value => typeof value === 'string' && /^\d{1,64}$/.test(value);
// 2026-10-26 主人定：对方回的是「重活」（做题、证明、总结、翻译、写代码…）时**干脆不回**，
// 一次模型都不发，省掉推理那一大截 token。
const HEAVY_PATTERN = /(帮我|帮忙|能不能帮|请你|麻烦你|求解|解一下|解方程|做一道|做一下这道|证明|推导|推一下|计算|算一下|算算|总结|概括|归纳|梳理|翻译|写个|写一段|写一篇|写代码|代码|程序|脚本|方案|计划|分析一下|分析下|评估|解释一下|解释下|怎么做|怎么实现|如何实现|优化一下|作业|题目|论文)/;
const HEAVY_MARKS = /```|∫|Σ|√|≈|≠|≤|≥|\$\$|\\frac|\\sum/;
export function heavyReply(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if ([...value].length > 120) return '超过 120 字';
  if (HEAVY_MARKS.test(value)) return '含代码或公式';
  if (((value.match(/[？?]/g) || []).length) >= 3) return '连着问了三个问题';
  const hit = HEAVY_PATTERN.exec(value);
  if (hit) return `像在派活（「${hit[1]}」）`;
  return null;
}

// 只读通知面板、只回「回复了你的评论」这一类；每条作品最多 4 次，同一条回复永久去重。
export class ReplyService {
  constructor({ controller, replies, videoLimits, generate, stateDir = resolveRuntimePaths().stateDir, source = 'api', now = Date.now } = {}) {
    if (!['api', 'dsh'].includes(source)) throw new TypeError('回复入口只能是 api 或 dsh。');
    this.source = source; this.stateDir = stateDir; this.now = now; this.generate = generate;
    this.videoLimits = videoLimits ?? new VideoLimits({ stateDir });
    this.controller = controller ?? new BrowserController({ source, videoLimits: this.videoLimits });
    this.ownsController = !controller;
    this.replies = replies ?? new AutonomousReplies({ videoLimits: this.videoLimits, stateDir, source, now });
    this.busy = null;
    this.skippedFile = path.join(stateDir, 'replies-skipped.json');
  }
  state() { return this.replies.state(); }
  skippedCids() { try { const value = JSON.parse(fs.readFileSync(this.skippedFile, 'utf8')); return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []); } catch { return new Set(); } }
  markSkipped(cid) { if (typeof cid !== 'string' || !cid) return; const set = this.skippedCids(); set.add(cid); try { fs.writeFileSync(this.skippedFile, JSON.stringify([...set].slice(-500))); } catch { /* 记不上不影响跳过 */ } }
  async openPanel(page) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    const bell = await page.evaluate(`(() => {
      const all = [...document.querySelectorAll('div,button,a,span')].filter(el => el.offsetParent);
      const el = all.find(el => (el.innerText || '').trim() === '通知' && el.getBoundingClientRect().width < 120);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!bell) throw fail('找不到通知入口，未回复。');
    await page.mouse.click(bell.x, bell.y);
    await page.waitForTimeout(1_600);
    const ready = await page.evaluate(`/互动消息/.test(document.body.innerText || '')`);
    if (!ready) throw fail('互动消息面板没有打开，未回复。');
  }
  async hasUnread(page) {
    // 铃铛右上角那枚红点是 .semi-badge-dot；没有红点就不开面板（2026-10-24 主人提醒）。
    return await page.evaluate(`(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const all = [...document.querySelectorAll('div,button,a,span')].filter(el => el.offsetParent);
      const bell = all.find(el => (el.innerText || '').trim() === '通知' && el.getBoundingClientRect().width < 120);
      if (!bell) return null;
      let wrap = bell;
      for (let i = 0; i < 4 && wrap.parentElement; i++) wrap = wrap.parentElement;
      return [...wrap.querySelectorAll('.semi-badge-dot')].some(vis);
    })()`);
  }
  async scan(page) {
    await this.openPanel(page);
    return await page.evaluate(`(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const title = [...document.querySelectorAll('div')].find(el => vis(el) && (el.innerText || '').trim() === '互动消息');
      if (!title) return [];
      let panel = title;
      for (let i = 0; i < 12; i++) { const r = panel.getBoundingClientRect(); if (r.width > 300 && r.height > 400) break; if (!panel.parentElement) break; panel = panel.parentElement; }
      const out = [], seen = new Set();
      for (const el of panel.querySelectorAll('div')) {
        const text = (el.innerText || '').trim();
        if (!text.includes('回复了你的评论')) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 60 || r.height > 100 || r.width < 280 || r.width > 320) continue;
        const key = Math.round(r.y);
        if (seen.has(key)) continue;
        seen.add(key);
        const lines = text.split('\\n').map(line => line.trim()).filter(Boolean);
        const actionAt = lines.findIndex(line => line.includes('回复了你的评论'));
        out.push({ text: text.replace(/\\n+/g, ' | '), replyText: actionAt > 0 ? lines[actionAt - 1] : '', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }
      return out;
    })()`);
  }
  async landing(page) {
    return await page.evaluate(`(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const cidOf = row => row.querySelector('[id^="tooltip_"]')?.id?.replace(/^tooltip_/, '') || row.getAttribute('data-comment-id') || null;
      const mine = row => row.getAttribute('data-is-self') === 'true' || Boolean(row.querySelector('[data-e2e="comment-self"]'));
      const rows = [...document.querySelectorAll('[data-e2e="comment-item"]')].filter(vis);
      const leaf = rows.filter(row => ![...row.querySelectorAll('[data-e2e="comment-item"]')].some(inner => inner !== row));
      let videoId = null;
      try { videoId = new URL(location.href).searchParams.get('modal_id'); } catch {}
      if (!/^\\d{1,64}$/.test(videoId || '')) { try { videoId = /\\/video\\/(\\d{1,64})/.exec(new URL(location.href).pathname)?.[1] || null; } catch {} }
      return { videoId, items: leaf.map(row => ({ cid: cidOf(row), mine: mine(row), text: (row.innerText || '').replace(/\\n+/g, ' | ').slice(0, 200) })) };
    })()`);
  }
  async locate(page, replyText, allowedCids = []) {
    return await page.evaluate(`(() => {
      const norm = v => String(v || '').replace(/[\\u200B-\\u200F\\uFEFF]/g, '').replace(/\\s+/g, '');
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const cidOf = row => row.querySelector('[id^="tooltip_"]')?.id?.replace(/^tooltip_/, '') || row.getAttribute('data-comment-id') || null;
      const allowed = new Set(${JSON.stringify(allowedCids || [])});
      let videoId = null;
      try { videoId = new URL(location.href).searchParams.get('modal_id'); } catch {}
      if (!/^\\d{1,64}$/.test(videoId || '')) { try { videoId = /\\/video\\/(\\d{1,64})/.exec(new URL(location.href).pathname)?.[1] || null; } catch {} }
      const wanted = norm(${JSON.stringify(replyText || '')});
      if (!wanted && !allowed.size) return { videoId, skipped: '通知里没有可核对的回复正文' };
      const rows = [...document.querySelectorAll('[data-e2e="comment-item"]')].filter(vis);
      for (const row of rows) {
        if ([...row.querySelectorAll('[data-e2e="comment-item"]')].some(inner => inner !== row)) continue;
        const cid = cidOf(row);
        // 优先按通知给的 cid 认，避免把我自己那条「不会，你先变一个我看看」当成目标（它包含「你先变」）。
        if (allowed.size ? !allowed.has(cid) : !norm(row.innerText).includes(wanted)) continue;
        const targetId = cidOf(row);
        if (!targetId) continue;
        let parent = row.parentElement, parentId = null;
        while (parent && !parentId) { if (parent.matches?.('[data-e2e="comment-item"]')) parentId = cidOf(parent); parent = parent.parentElement; }
        const r = row.getBoundingClientRect();
        const author = (row.innerText || '').split('\\n').map(line => line.trim()).filter(Boolean)[0] || '';
        return { videoId, targetId, parentId, author, text: (row.innerText || '').replace(/\\n+/g, ' | ').slice(0, 200), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return { videoId, skipped: '当前页面没有找到这条回复' };
    })()`);
  }
  async expandReplies(page) {
    // 2026-10-24：回给我的回复如果再被别人回复，会折叠在「展开 N 条回复」里，不展开就定位不到。
    const points = await page.evaluate(`(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return [...document.querySelectorAll('div,span')].filter(el => vis(el) && /^展开\\s*\\d+\\s*条回复$/.test((el.innerText || '').trim()))
        .slice(0, 4).map(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    })()`);
    for (const point of points) { await page.mouse.click(point.x, point.y); await page.waitForTimeout(800); }
    return points.length;
  }
  async post(page, { videoId, targetId, text, signal }) {
    const before = await page.evaluate(`(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return [...document.querySelectorAll('[data-e2e="comment-item"]')].filter(vis).map(row => row.querySelector('[id^="tooltip_"]')?.id?.replace(/^tooltip_/, '') || row.getAttribute('data-comment-id') || '').filter(Boolean);
    })()`);
    const target = await page.evaluate(`(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const row = [...document.querySelectorAll('[data-e2e="comment-item"]')].filter(vis).find(row => (row.querySelector('[id^="tooltip_"]')?.id || '').replace(/^tooltip_/, '') === ${JSON.stringify(targetId)} || row.getAttribute('data-comment-id') === ${JSON.stringify(targetId)});
      if (!row) return null;
      const btn = [...row.querySelectorAll('span,div,a')].filter(el => vis(el) && (el.innerText || '').trim() === '回复').pop();
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!target) throw fail('没有找到那条回复的“回复”按钮，未发布。');
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(1_500);
    const box = await page.evaluate(`(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const root = [...document.querySelectorAll('#comment-input-container,.comment-input-container')].find(el => vis(el) && /回复@/.test(el.innerText || ''));
      if (!root) return null;
      const ed = [...document.querySelectorAll('[contenteditable="true"]')].filter(vis).pop();
      if (!ed) return null;
      const r = ed.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box) throw fail('回复输入框没有出现，未发布。');
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(250);
    await page.keyboard.insertText(text);
    await page.waitForTimeout(600);
    const ready = await page.evaluate(`(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(vis);
      const draft = (eds[eds.length - 1]?.innerText || '').trim();
      const er = eds[eds.length - 1]?.getBoundingClientRect();
      const svgs = [...document.querySelectorAll('.commentInput-right-ct span:last-child svg')].filter(vis).map(el => el.getBoundingClientRect())
        .sort((a, b) => Math.abs(a.y - er.y) - Math.abs(b.y - er.y));
      const r = svgs[0];
      return { draft, send: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null };
    })()`);
    if (ready.draft !== text || !ready.send) throw fail('回复正文没有完整进入输入框，未发布。');
    await page.mouse.click(ready.send.x, ready.send.y);
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      signal?.throwIfAborted();
      const found = await page.evaluate(`(() => {
        const norm = v => String(v || '').replace(/[\\u200B-\\u200F\\uFEFF]/g, '').replace(/\\s+/g, '');
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const known = new Set(${JSON.stringify(before)});
        for (const row of document.querySelectorAll('[data-e2e="comment-item"]')) {
          if (!vis(row)) continue;
          const cid = row.querySelector('[id^="tooltip_"]')?.id?.replace(/^tooltip_/, '') || row.getAttribute('data-comment-id') || '';
          if (!cid || known.has(cid)) continue;
          if (norm(row.innerText).includes(norm(${JSON.stringify(text)}))) return cid;
        }
        return null;
      })()`);
      if (found) { return { confirmed: true, replyId: found }; }
    }
    return { confirmed: false, deliveryUncertain: true, reason: '已点击发送，但没有回读到新回复编号，请人工核对。' };
  }
  async notices(page) {
    // 2026-10-24：发现改用页面内 fetch「互动通知」，比点通知 UI 稳；只读、不标已读。
    // 条目里的回复正文在 comment.comment.text，回复编号 cid、作品 aweme_id、作者 nickname 也在里面。
    return await page.evaluate(`(async () => {
      const COMMON = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=190500&version_name=19.5.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10&platform=PC';
      const out = [], seen = new Set();
      for (const group of [700, 960]) {
        try {
          const response = await fetch('/aweme/v1/web/notice/?' + COMMON + '&is_new_notice=1&is_mark_read=0&count=20&min_time=0&group=' + group + '&notice_group=' + group, { credentials: 'include' });
          const data = await response.json();
          for (const item of data.notice_list_v2 || []) {
            const block = item.comment || {};
            const comment = block.comment || null;
            if (!comment || !comment.cid || !comment.aweme_id) continue;
            if (seen.has(comment.cid)) continue;
            seen.add(comment.cid);
            out.push({ nid: String(item.nid || ''), cid: String(comment.cid), videoId: String(comment.aweme_id), text: String(comment.text || ''), author: String(comment.user?.nickname || ''), kind: Number(block.comment_type || 0), parentId: String(block.parent_id || block.reply_comment?.cid || ''), at: Number(item.create_time || 0), contentType: Number(comment.content_type || 0), stickerId: comment.sticker && comment.sticker.id ? String(comment.sticker.id) : '', stickerUrl: String((comment.sticker && comment.sticker.static_url && comment.sticker.static_url.url_list && comment.sticker.static_url.url_list[0]) || (comment.sticker && comment.sticker.animate_url && comment.sticker.animate_url.url_list && comment.sticker.animate_url.url_list[0]) || ''), imageUrl: (function () { const list = (comment.image_list && comment.image_list[0] && comment.image_list[0].origin_url && comment.image_list[0].origin_url.url_list) || []; if (!list.length) return ''; const jpeg = list.find(function (u) { return String(u).indexOf('.jpeg') >= 0; }); return String(jpeg || list[0]); })() });
          }
        } catch { /* 一个分组失败不影响其他的 */ }
      }
      return out;
    })()`);
  }
  // 2026-10-26 主人定：对方回「表情」（content_type=2、正文为空）也要能看到——
  // 表情是图片，有的里面带一句台词。下载下来取第一帧转 JPEG，交给模型读那句话；读不出就放弃。
  ffmpegPath() {
    const fromEnv = String(process.env.DOUYIN_MEDIA_FFMPEG || '').trim();
    if (fromEnv) return fromEnv;
    try {
      const text = fs.readFileSync(new URL('./media/.env', import.meta.url), 'utf8');
      const hit = /^DOUYIN_MEDIA_FFMPEG=(.+)$/m.exec(text);
      if (hit) return hit[1].trim();
    } catch { /* 没有 media/.env 就往下走 */ }
    const known = 'D:\\Deep\\tools\\ffmpeg\\bin\\ffmpeg.exe';
    return fs.existsSync(known) ? known : 'ffmpeg';
  }
  async stickerFrame(url, { signal } = {}) {
    if (!/^https:\/\/[\w.-]*douyinpic\.com\//.test(String(url || ''))) throw new Error('表情图片地址不在允许的域名内，未读取。');
    const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const response = await fetch(url, { headers: { referer: 'https://www.douyin.com/' }, redirect: 'error', signal: timeout });
    if (!response.ok) throw new Error('表情图片下载失败（HTTP ' + response.status + '）。');
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8_000_000) throw new Error('表情图片大小超出限制。');
    if (/^image\/(jpeg|png|webp)$/.test(type) && bytes.length <= 1_500_000) return { mimeType: type, data: bytes.toString('base64') };
    // 表情大多是动图（GIF），模型的画面接口只收 jpeg/png/webp，取第一帧转 JPEG。
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-sticker-'));
    const input = path.join(workdir, 'in.bin'), output = path.join(workdir, 'out.jpg');
    try {
      fs.writeFileSync(input, bytes);
      await new Promise((resolve, reject) => execFile(this.ffmpegPath(), ['-y', '-v', 'error', '-i', input, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '4', output], { timeout: 20_000 }, error => error ? reject(error) : resolve(undefined)));
      const jpeg = fs.readFileSync(output);
      if (!jpeg.length || jpeg.length > 2_000_000) throw new Error('表情图片转换后大小异常。');
      return { mimeType: 'image/jpeg', data: jpeg.toString('base64') };
    } finally { fs.rmSync(workdir, { recursive: true, force: true }); }
  }
  // 2026-10-26 21:45：主人发现主人的回复她一条都没回。checkApi 的失败只进了 onEvent，没落盘，查不出原因。
  // 这里把每次检查的入口、通知数、错误都追加到 state/replies-checks.jsonl。
  trace(event) {
    try { fs.appendFileSync(path.join(this.stateDir, 'replies-checks.jsonl'), JSON.stringify({ at: new Date(this.now()).toISOString(), ...event }) + '\n'); } catch { /* 记不上不影响回复 */ }
  }
  async postViaApi(page, { videoId, targetId, text }) {
    // 2026-10-24：在页面里 fetch 发回复——不点 UI、不导航、不暂停正在看的视频（点通知那条路会暂停整轮）。
    const result = await page.evaluate(`(async () => {
      const COMMON = { device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1', version_code: '190500', version_name: '19.5.0', cookie_enabled: 'true', screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '141.0.0.0', engine_name: 'Blink', engine_version: '141.0.0.0', os_name: 'Windows', os_version: '10', platform: 'PC' };
      const qs = data => Object.keys(data).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(data[key])).join('&');
      const url = '/aweme/v1/web/comment/publish/?' + qs(Object.assign({}, COMMON, { app_name: 'aweme' }));
      const body = Object.assign({}, COMMON, { aweme_id: ${JSON.stringify(videoId)}, text: ${JSON.stringify(text)}, text_extra: '[]', aweme_type: '0', channel_id: '0', city: '', sticker_id: '', is_fold: '0', reply_id: ${JSON.stringify(targetId)}, reply_to_reply_id: ${JSON.stringify(targetId)} });
      try {
        const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.douyin.com/' }, body: new URLSearchParams(body).toString() });
        const raw = await response.text();
        let data = null; try { data = JSON.parse(raw); } catch {}
        return { http: response.status, code: data && data.status_code !== undefined ? data.status_code : null, cid: data && data.comment && data.comment.cid ? String(data.comment.cid) : '', head: raw.slice(0, 200) };
      } catch (error) { return { http: 0, code: null, cid: '', head: String(error && error.message || error).slice(0, 200) }; }
    })()`);
    if (result.http === 200 && result.code === 0 && result.cid) return { confirmed: true, replyId: result.cid };
    return { confirmed: false, deliveryUncertain: false, reason: `接口没有确认发布（http=${result.http} code=${result.code}）${result.head ? '：' + result.head.slice(0, 120) : ''}` };
  }
  // 只用接口的版本：轮中也能跑，不碰画面。
  async checkApi({ max = 1, signal, decisionProvider } = {}) {
    const policy = this.replies.policy();
    if (!policy.enabled) throw fail('自主回复未启用。');
    const time = this.videoLimits.state();
    if (!time.allowed) throw fail(time.reason || '有限视频轮次已结束，未回复。');
    if (this.busy) throw fail('已有一次回复检查在进行。');
    this.busy = randomUUID();
    const result = { notices: 0, replied: [], skipped: [] };
    this.trace({ stage: 'start', max });
    try {
      return await this.controller.withPage(async page => {
        const notices = await this.notices(page);
        result.notices = notices.length;
        this.trace({ stage: 'notices', notices: notices.length });
        const skippedBefore = this.skippedCids();
        const fresh = notices.filter(item => item.kind === 2 && item.cid && (item.text || item.stickerId) && !this.replies.answered(item.cid) && !skippedBefore.has(item.cid) && (!policy.selfAccount || String(item.author).normalize('NFKC').trim() !== policy.selfAccount.normalize('NFKC')));
        this.trace({ stage: 'fresh', count: fresh.length, cids: fresh.slice(0, 3).map(item => item.cid) });
        if (!fresh.length) { result.skipped.push({ reason: '没有新的回复通知' }); return result; }
        for (const notice of fresh.slice(0, max)) {
          signal?.throwIfAborted();
          // 2026-10-26 主人定：重活干脆不回（0 token），记一笔免得同一条一直占名额。
          const heavy = notice.text ? heavyReply(notice.text) : null;
          if (heavy) { this.markSkipped(notice.cid); result.skipped.push({ reason: `重活不回：${heavy}`, targetId: notice.cid, text: String(notice.text || '').slice(0, 40) }); continue; }
          // 表情回复：先取第一帧，模型读得出图里的台词才回；读不出就不回（不猜）。
          // 没有正文的两种：抖音表情（sticker）和相册图片（image_list），读取方式一样。
          let sticker = null;
          if (!notice.text) {
            const mediaUrl = notice.stickerUrl || notice.imageUrl;
            if (!mediaUrl) { this.markSkipped(notice.cid); result.skipped.push({ reason: '表情/图片没有可用地址', targetId: notice.cid }); continue; }
            try { sticker = await this.stickerFrame(mediaUrl, { signal }); }
            catch (error) { this.markSkipped(notice.cid); result.skipped.push({ reason: `图片读不出来：${String(error?.message || error).slice(0, 60)}`, targetId: notice.cid }); continue; }
          }
          const generated = this.generate ? await this.generate({ replyText: notice.text, sticker, myComment: '', videoTitle: '', signal, decisionProvider }) : { text: null };
          // 表情里读不出台词就永远读不出，记一笔跳过，别每 20 秒重问一次模型。
          if (!generated?.text) { if (sticker) this.markSkipped(notice.cid); result.skipped.push({ reason: sticker ? '表情没看懂，不回' : '生成放弃', targetId: notice.cid }); continue; }
          const isMaster = Boolean(policy.masterAccount) && String(notice.author || '').normalize('NFKC').trim() === policy.masterAccount.normalize('NFKC');
          if (!isMaster && this.replies.operationsForVideo(notice.videoId).filter(item => item.status !== 'not-sent' && !item.master).length >= policy.perVideo) { result.skipped.push({ reason: '这条作品的回复次数已满', videoId: notice.videoId }); continue; }
          const operation = this.replies.reserve({ videoId: notice.videoId, parentId: notice.parentId || '0', targetId: notice.cid, targetAuthor: notice.author, text: generated.text });
          const posted = await this.postViaApi(page, { videoId: notice.videoId, targetId: notice.cid, text: generated.text });
          if (posted.confirmed) {
            // 落一份用量，好核对「表情回复比纯文字多花多少」。
            this.replies.update(operation.operationId, { status: 'confirmed', replyId: posted.replyId, completedAt: new Date(this.now()).toISOString(), usage: generated.usage || {}, kind: sticker ? (notice.stickerUrl ? 'sticker' : 'image') : 'text' });
            result.replied.push({ videoId: notice.videoId, targetId: notice.cid, replyId: posted.replyId, text: generated.text, via: 'api', kind: sticker ? (notice.stickerUrl ? 'sticker' : 'image') : 'text', usage: generated.usage || {} });
          } else {
            this.replies.update(operation.operationId, { status: posted.deliveryUncertain ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString() });
            result.skipped.push({ reason: posted.reason || '接口没有确认发布', targetId: notice.cid });
          }
        }
        return result;
      }, { signal });
    } catch (error) { this.trace({ stage: 'error', message: String(error?.message || error).slice(0, 160) }); throw error; }
    finally { this.busy = null; this.trace({ stage: 'done', replied: result.replied.length, skipped: result.skipped.length }); }
  }
  async close() { if (this.ownsController) await this.controller.close(); }
}
