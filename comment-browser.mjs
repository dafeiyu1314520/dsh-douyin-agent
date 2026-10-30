import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserController, readPageState } from './core.mjs?v=9';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { validateCommentText } from './autonomous-comments.mjs';

const stop = signal => signal?.throwIfAborted();
const cleanDraft = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
// 2026-10-23 实测：详情页的输入容器是 id="comment-input-container"，推荐流面板里是 class="comment-input-container"；
// 两种都要认，且编辑器要等点了容器才出现（Draft.js）。
const CONTAINER = '#comment-input-container,.comment-input-container';
const EDITORS = '#comment-input-container [contenteditable="true"],.comment-input-container [contenteditable="true"],#comment-input-container textarea,.comment-input-container textarea,[data-e2e="comment-input"] [contenteditable="true"],textarea[data-e2e="comment-input"],[contenteditable="true"][data-e2e="comment-input"]';
const SEND = '.commentInput-right-ct span:last-child svg';
// 2026-10-26 主人提醒：评论框占位是「留下你的精彩评论吧」，私信输入框是「发送消息」，
// 而且结构也不同——评论是 Draft（.public-DraftEditor-content），私信是 Slate（data-slate-editor）。
const COMMENT_PLACEHOLDER = '留下你的精彩评论吧';
// 2026-10-23 主人定：她发评论时把他 @ 进来（他账号昵称「测试用小猫」）。
// 必须是 UI 点选才算真 @：API 直发的 @ 会被剥掉 sec_uid，对方收不到通知。
const MENTION_NAME = String(process.env.DOUYIN_MENTION_NAME || '测试用小猫').trim();
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };

// 只读公开评论的编号、正文和自身发出状态；不采集其他评论者的账号、昵称或头像。
export function readCommentDom(expectedVideoId) {
  const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
  const result = [];
  for (const row of document.querySelectorAll('[data-e2e="comment-item"]')) {
    if (!visible(row) || row.closest('[data-e2e="im-dialog"]')) continue;
    const ancestorVideoId = row.closest('[data-aweme-id],[data-video-id]')?.getAttribute('data-aweme-id') || row.closest('[data-video-id]')?.getAttribute('data-video-id');
    if (ancestorVideoId && ancestorVideoId !== expectedVideoId) continue;
    const rawId = row.getAttribute('data-comment-id') || row.querySelector('[id^="tooltip_"]')?.getAttribute('id')?.replace(/^tooltip_/, '') || /^comment_(\d+)$/.exec(row.id)?.[1];
    const textNode = row.querySelector('[data-e2e="comment-content"],.comment-item-content');
    const text = (textNode?.innerText || textNode?.textContent || '').trim();
    const mine = row.getAttribute('data-is-self') === 'true' || row.getAttribute('data-author-is-self') === 'true' || Boolean(row.querySelector('[data-e2e="comment-self"]'));
    const status = row.getAttribute('data-send-status') || row.getAttribute('data-comment-status') || '';
    const pending = /^(?:sending|pending|reviewing)$/.test(status) || Boolean(row.querySelector('[data-e2e="comment-pending"],[aria-busy="true"],[class*="sending" i]'));
    const failed = /^(?:failed|rejected|error)$/.test(status) || Boolean(row.querySelector('[data-e2e="comment-failed"],[class*="sendFail"]'));
    const sent = /^(?:sent|published|success)$/.test(status) || mine && /^\d{1,64}$/.test(rawId || '') && !pending && !failed;
    result.push({ commentId: /^\d{1,64}$/.test(rawId || '') ? rawId : null, videoId: ancestorVideoId || expectedVideoId, text, mine, sent, pending, failed });
  }
  return { rows: result };
}

// 2026-10-23 实测：每条评论行只有 id="tooltip_<cid>" 一个稳定编号，正文没有独立的 DOM 节点；
// 所以发布回读改成"新出现的编号 + 该行包含正文"，不用旧的 data-e2e="comment-content"。只读。
export function listCommentIds() {
  const ids = [];
  for (const row of document.querySelectorAll('[data-e2e="comment-item"]')) {
    if (row.closest('[data-e2e="im-dialog"]')) continue;
    const raw = row.getAttribute('data-comment-id') || row.querySelector('[id^="tooltip_"]')?.getAttribute('id')?.replace(/^tooltip_/, '') || /^comment_(\d+)$/.exec(row.id)?.[1];
    if (/^\d{1,64}$/.test(raw || '')) ids.push(raw);
  }
  return ids;
}

export function findPostedComment({ text, beforeIds }) {
  const norm = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, '');
  const wanted = norm(text);
  const known = new Set(beforeIds || []);
  for (const row of document.querySelectorAll('[data-e2e="comment-item"]')) {
    if (row.closest('[data-e2e="im-dialog"]')) continue;
    const raw = row.getAttribute('data-comment-id') || row.querySelector('[id^="tooltip_"]')?.getAttribute('id')?.replace(/^tooltip_/, '') || /^comment_(\d+)$/.exec(row.id)?.[1];
    if (!/^\d{1,64}$/.test(raw || '') || known.has(raw)) continue;
    if (norm(row.innerText).includes(wanted)) return raw;
  }
  return null;
}

function assertVideo(state, expectedVideoId) {
  if (state?.loginRequired || state?.verificationRequired || state?.unsupportedPage || state?.privateChatVisible || state?.blocked || state?.video?.id !== expectedVideoId || state.video.readyState < 2) throw new Error('当前作品、登录状态或页面遮挡无法核对，未发布评论。');
  const url = state.video.url || state.url;
  if (url) { let current; try { current = new URL(url); } catch {} if (!current || current.origin !== 'https://www.douyin.com' || /^\/video\/(\d+)\/?$/.exec(current.pathname)?.[1] !== expectedVideoId) throw new Error('当前作品链接与预期不一致，未发布评论。'); }
}

export class CommentBrowser {
  constructor({ source = 'api', controller, videoLimits, stateDir = resolveRuntimePaths().stateDir } = {}) {
    if (!['api', 'dsh'].includes(source)) throw new TypeError('评论入口只能是 api 或 dsh。');
    this.source = source; this.stateDir = stateDir;
    this.videoLimits = videoLimits ?? new VideoLimits({ stateDir });
    // 默认创建独立的同入口控制器，不能复用正在等待评论结果的父控制器队列。
    this.controller = controller ?? new BrowserController({ source, videoLimits: this.videoLimits }); this.ownsController = !controller;
    this.receiptsFile = path.join(stateDir, 'comment-browser-receipts.json'); this.guardFile = path.join(stateDir, 'comment-post.guard');
  }
  receipts() { try { const value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8')); if (!value || value.version !== 1 || !Array.isArray(value.operations) || value.operations.some(item => !item || typeof item.operationId !== 'string' || !/^\d{1,64}$/.test(item.videoId) || !['clicking', 'confirmed', 'uncertain'].includes(item.status))) throw Error(); return value; } catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw new Error('原评论发布收据无法核对，未自动重发。'); } }
  record(operation) { const value = this.receipts(), index = value.operations.findIndex(item => item.operationId === operation.operationId); if (index < 0) value.operations.push(operation); else value.operations[index] = operation; write(this.receiptsFile, value); }
  acquire() { fs.mkdirSync(this.stateDir, { recursive: true }); let descriptor; try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('其他评论仍在处理，或发布锁需要核对；未抢锁重试。'); throw error; } const owner = { pid: process.pid, token: randomUUID() }; try { fs.writeFileSync(descriptor, JSON.stringify(owner)); } finally { fs.closeSync(descriptor); } return () => { const current = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.guardFile); }; }
  async gate(signal) { stop(signal); const state = this.videoLimits.state(); if (!state.allowed) throw new Error(state.reason || '有限观看时段已结束，未发布评论。'); }
  // 2026-10-26：把「打 @ + 名字头两个字 → 点弹层里的昵称」抽成方法，供两个 @ 复用。
  // exact=true 只认完全相同的昵称，避免把「测试用主人」当成「测试用小猫」点掉。
  async insertMention(page, editor, name, { exact = false } = {}) {
    const target = String(name || '').trim();
    if (!target) return false;
    await page.keyboard.type('@').catch(() => {});
    await page.waitForTimeout(600);
    const probe = target.slice(0, 2);
    await page.keyboard.type(probe).catch(() => {});
    await page.waitForTimeout(1_000);
    // 2026-10-26 实测：私信面板开着时整页扫名字会命中私信会话行，点下去焦点跳到私信输入框。
    // 所以只在评论框上下附近找，并且排除私信面板里的任何节点。
    const bounds = await editor.boundingBox().catch(() => null);
    const point = await page.evaluate(({ name, bounds, exact }) => {
      const hits = [];
      for (const el of document.querySelectorAll('span,div')) {
        if (el.childElementCount) continue;
        if (el.closest('[data-e2e="im-dialog"]')) continue;
        const t = (el.textContent || '').trim();
        if (!t) continue;
        if (t !== name && !t.startsWith(name)) continue;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        if (bounds && (r.y < bounds.y - 420 || r.y > bounds.y + bounds.height + 120)) continue;
        hits.push({ text: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }
      const exactHit = hits.find((item) => item.text === name);
      if (exactHit) return { x: exactHit.x, y: exactHit.y };
      // 认不到完全一样的昵称时，只有候选唯一才敢点——宁可不 @，也别点到别人。
      return exact && hits.length === 1 ? { x: hits[0].x, y: hits[0].y } : (!exact ? (hits[0] || null) : null);
    }, { name: target, bounds, exact });
    if (!point) {
      for (let i = 0; i < probe.length + 1; i++) await page.keyboard.press('Backspace').catch(() => {});
      await page.waitForTimeout(150);
      return false;
    }
    await page.mouse.click(point.x, point.y); await page.waitForTimeout(500);
    await page.keyboard.type(' ').catch(() => {}); await page.waitForTimeout(150);
    return true;
  }

  // 2026-10-26 主人定：评论发完把评论区收回去（按 x），别一直挡着视频。
  // 只在面板确实开着的时候按——x 是开关，面板关着时按反而会打开。
  async closeCommentPanel(page) {
    try {
      const open = await page.locator(CONTAINER).evaluateAll(nodes => nodes.some(el => {
        const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        if (!(r.width > 8 && r.height > 8)) return false;
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
        return r.right > 8 && r.bottom > 8 && r.left < innerWidth - 8 && r.top < innerHeight - 8;
      })).catch(() => false);
      if (!open) return false;
      await page.keyboard.press('x').catch(() => {});
      await page.waitForTimeout(600);
      return true;
    } catch { return false; }
  }

  async post({ expectedVideoId, text, extraMentionName = '', ...extra } = {}, { signal: parentSignal, authorize, autonomousRunId } = {}) {
    if (typeof expectedVideoId !== 'string' || !/^\d{1,64}$/.test(expectedVideoId) || Object.keys(extra).length) throw new TypeError('评论只能指定当前作品编号与纯文字。');
    text = validateCommentText(text);
    if (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function') return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论缺少可信本机许可与最终短输入控制，未发布。' };
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (await authorize({ phase, videoId: expectedVideoId }) !== true) throw new Error('自主评论许可已撤回，未继续发布。'); stop(signal); };
    await authorized('prepare'); await this.gate(signal);
    const release = this.acquire(), operation = { operationId: randomUUID(), videoId: expectedVideoId, startedAt: new Date().toISOString(), status: 'clicking' };
    let clicked = false, dispatched = false, receiptWritten = false, releaseDispatch = null, cleanupWitness = null;
    try {
      if (this.receipts().operations.some(item => item.videoId === expectedVideoId)) throw new Error('同一作品已有发布或待核对评论收据，未再次点击。');
      return await this.controller.withPage(async page => {
        await authorized('monitor'); await this.gate(signal); assertVideo(await page.evaluate(readPageState), expectedVideoId);

        // 2026-10-23：评论框默认只是一个占位条，先滚到视野里、点一下才会出现 Draft 编辑器；
        // 推荐流里还要先点开评论区面板。每一步都要求"唯一"，找不到就如实退回，不猜坐标。
        // 2026-10-26 主人纠正：15:22 那次屏幕上只有视频，根本没有评论面板——旧的 `filter({visible:true})`
        // 只要求"有尺寸"，**不要求落在视口里**，于是把画在屏幕外（或藏在视频后面）的评论容器当成"已打开"，
        // 跳过 X 热键 → 去点一个点不到的位置 → 1.2 秒判失败。现在改成按视口交集判断。
        const panelOpen = async () => page.locator(CONTAINER).evaluateAll(nodes => nodes.some(el => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          if (!(r.width > 8 && r.height > 8)) return false;
          if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
          return r.right > 8 && r.bottom > 8 && r.left < innerWidth - 8 && r.top < innerHeight - 8;
        })).catch(() => false);
        const openBox = async () => {
          const rootLocator = () => page.locator(CONTAINER).filter({ visible: true }).first();
          if (!await panelOpen()) {
            // 2026-10-23 主人提示：抖音按 X 键就能开关评论区，比点图标稳。先按热键。
            await page.keyboard.press('x').catch(() => {});
            await page.waitForTimeout(1_800);
            this.lastOpenDiagnostic = { via: 'hotkey', ...(this.lastOpenDiagnostic || {}) };
          }
          for (let attempt = 0; attempt < 2 && !await panelOpen(); attempt++) {
            const icon = page.locator('[data-e2e="feed-comment-icon"]').filter({ visible: true }).first();
            if (await icon.count()) { await icon.click({ timeout: 3_000 }).catch(() => {}); await page.waitForTimeout(attempt ? 2_500 : 1_800); }
          }
          if (!await panelOpen()) {
            const rect = await page.locator(CONTAINER).first().evaluate(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight }; }).catch(() => null);
            this.lastOpenDiagnostic = { containers: await page.locator(CONTAINER).count(), icons: await page.locator('[data-e2e="feed-comment-icon"]').count(), rect, url: page.url() };
            return null;
          }
          const root = rootLocator();
          // 2026-10-23 主人指出的：推荐流里点开评论面板后，输入条本来就固定在面板底部，已经可见；
          // 这一下 scrollIntoView 会把整列往上顶、视频被迫移出画面，看起来像页面被弄乱了。只有真的看不到才滚。
          const rect = await root.evaluate(element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, viewport: innerHeight }; }).catch(() => null);
          if (rect && !(rect.top >= 0 && rect.bottom <= rect.viewport && rect.height > 0)) {
            await root.evaluate(element => element.scrollIntoView({ block: 'center' })).catch(() => {}); await page.waitForTimeout(500);
          }
          // 2026-10-24：推荐流里这条是 336×46 的横条，点「正中间」落在表情/图标上，编辑器不出来。
          // 先点占位文字本身（最稳），找不到再退回左边缘。
          const tapPlaceholder = async () => {
            const ph = await root.evaluate(el => {
              for (const n of [el, ...el.querySelectorAll('span,div,p')]) {
                const txt = (n.textContent || '').trim();
                if (!txt || txt.length > 12 || n.childElementCount) continue;
                if (!/留下你的精彩评论|说点什么|善语/.test(txt)) continue;
                const r = n.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
              }
              return null;
            }).catch(() => null);
            if (ph) await page.mouse.click(ph.x, ph.y);
            else {
              const box = await root.boundingBox().catch(() => null);
              if (!box) return false;
              await page.mouse.click(box.x + 40, box.y + Math.min(box.height / 2, 24));
            }
            await page.waitForTimeout(900);
            return true;
          };
          let editors = page.locator(EDITORS).filter({ visible: true });
          if (await editors.count() === 0) {
            if (!await tapPlaceholder()) return null;
            editors = page.locator(EDITORS).filter({ visible: true });
          }
          // 2026-10-26：面板在、编辑器不出来。按 ESC 收掉、再按 X 重开评论区，然后重新点占位条。
          if (await editors.count() === 0) {
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(600);
            await page.keyboard.press('x').catch(() => {});
            await page.waitForTimeout(1_500);
            if (await panelOpen() && await tapPlaceholder()) editors = page.locator(EDITORS).filter({ visible: true });
          }
          this.lastOpenDiagnostic = { ...(this.lastOpenDiagnostic || {}), roots: await page.locator(CONTAINER).filter({ visible: true }).count(), editors: await editors.count() };
          return await editors.count() === 1 ? { root, editor: editors } : null;
        };
        const verifySameWork = async () => {
          // 2026-10-23：滚到评论框后视频会离开视口，video 会变 null；这里只核对页面没换、作品没换。
          const state = await page.evaluate(readPageState);
          if (state?.loginRequired || state?.verificationRequired || state?.unsupportedPage || state?.privateChatVisible) throw new Error('当前页面出现登录、验证或遮挡，未发布评论。');
          let fromUrl = null; try { fromUrl = /\/video\/(\d+)\/?$/.exec(new URL(page.url()).pathname)?.[1] || null; } catch {}
          if ((state?.video?.id || fromUrl) !== expectedVideoId) throw new Error('当前作品与预期不一致，未发布评论。');
        };
        // 2026-10-26：15:22 那次 1.2 秒就失败，多半是图标还没渲染出来就判了。找不到就再等一拍重试一次。
        let opened = await openBox();
        if (!opened) { await page.waitForTimeout(900); opened = await openBox(); }
        if (!opened) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: `当前页面没有唯一可核对的评论输入框，需要先打开评论面板或等待适配。${this.lastOpenDiagnostic ? `（现场：容器 ${this.lastOpenDiagnostic.containers} 个、图标 ${this.lastOpenDiagnostic.icons} 个、${this.lastOpenDiagnostic.url}）` : ''}` };
        const { root, editor } = opened, draft = () => editor.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText);
        // 2026-10-26：再核一次占位文字，确认不是私信那类输入框（两者长得像，但不是一回事）。
        const placeholder = await editor.evaluate((element) => {
          const host = element.closest('.comment-input-inner-container, .comment-input-container, #comment-input-container');
          const node = host?.querySelector('.public-DraftEditorPlaceholder-root, [data-placeholder], [placeholder]');
          return String(node?.getAttribute('data-placeholder') || node?.getAttribute('placeholder') || node?.textContent || '').trim();
        }).catch(() => '');
        if (placeholder && !placeholder.includes(COMMENT_PLACEHOLDER)) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: `当前可见的输入框不是评论框（占位文字：「${placeholder}」），未发布评论。` };
        if (cleanDraft(await draft())) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论输入框已有草稿或媒体内容，已保留原内容。' };
        if (await root.locator('[data-e2e="comment-reply-target"],.PPsJmqBy').filter({ visible: true }).count() || await editor.getAttribute('aria-label').then(value => /回复\s*[@＠]/.test(value || ''))) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '当前输入框处于回复他人的状态，未改发回复或@。' };
        this.lastMention = false;
        const beforeIds = await page.evaluate(listCommentIds);
        await editor.click({ timeout: 2_000 }); stop(signal); await this.gate(signal);
        // 2026-10-23 主人要求：把她这条评论 @ 给他。在编辑器里真打一个 @，等联系人弹层，
        // 点中昵称那一行（界面上才算真 @），再补正文。点不到就删掉这个 @，退回纯文字，不留半截。
        // 2026-10-26 主人定：默认 @ 主人；另有概率再 @ 一位白名单好友（名单和概率在 mention-picker 里，宿主传名字进来）。
        this.lastMention = false; this.lastExtraMention = false;
        if (MENTION_NAME) this.lastMention = await this.insertMention(page, editor, MENTION_NAME);
        const extraMention = String(extraMentionName || '').trim();
        if (this.lastMention && extraMention && extraMention !== MENTION_NAME) {
          this.lastExtraMention = await this.insertMention(page, editor, extraMention, { exact: true });
          if (!this.lastExtraMention) this.lastOpenDiagnostic = { ...(this.lastOpenDiagnostic || {}), extraMentionMissing: extraMention };
        }
        // 用浏览器真实文字输入触发受控编辑器；发送按钮只有正文进入后才会出现（实测）。
        // 2026-10-26：敲 @ 之后焦点可能已经跑到别处（私信面板），insertText 会写进别的输入框。
        await editor.focus().catch(() => {});
        // 2026-10-26 19:55（@ 失效根因）：这里原本无条件 editor.click()，Playwright 点的是元素中心——
        // 光标落在「@测试用小猫」第 3 个字后面，随后 insertText 把 mention 实体从中间劈开，抖音把整条退化成纯文本，
        // 谁都不会收到 @ 通知（10-25 那批旧评论没有这次 click，DOM 里是完整 <a href="/user/…"><span id="@测试用小猫">）。
        // 现在：只有编辑器没焦点才点它，点完一定把光标顶到行尾再写正文。
        const focusedNow = await editor.evaluate(el => el === document.activeElement || el.contains(document.activeElement)).catch(() => false);
        if (!focusedNow) { await editor.click({ timeout: 2_000 }).catch(() => {}); }
        await page.keyboard.press('End').catch(() => {});
        await page.keyboard.insertText(text); await page.waitForTimeout(400); stop(signal);
        // 2026-10-26：有 @ 时 innerText 会多出空格/零宽字符，直接 includes 会误判——15:57 那次正文明明在框里，
        // 却被判「没进去」直接跳过。现在两边都去掉所有空白和零宽字符再比，innerText / textContent 各读一次。
        const normalize = value => String(value ?? '').replace(/[\s\u200B-\u200F\u2060\uFEFF\u00A0]/g, '');
        const readDraft = async () => {
          const inner = await draft().catch(() => '');
          const content = await editor.evaluate(el => el.textContent || '').catch(() => '');
          return { inner: String(inner ?? ''), content: String(content ?? '') };
        };
        const hasText = read => normalize(read.inner).includes(normalize(text)) || normalize(read.content).includes(normalize(text));
        const hasMention = read => !this.lastMention || normalize(read.inner).includes(normalize(MENTION_NAME)) || normalize(read.content).includes(normalize(MENTION_NAME));
        let written = await readDraft();
        if (!hasText(written)) {
          // 2026-10-26：文字可能被送进了别的输入框。清掉重来一次，再把焦点按回评论框。
          await editor.focus().catch(() => {});
          await editor.click({ timeout: 2_000 }).catch(() => {});
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          await page.waitForTimeout(150);
          await page.keyboard.insertText(text);
          await page.waitForTimeout(400);
          written = await readDraft();
        }
        if (!hasText(written)) {
          // 2026-10-26：前两次 insertText 都没进去，最后一招直接在编辑器里执行 insertText 命令（Draft 会当成一次输入）。
          await editor.evaluate((element, value) => { element.focus(); document.execCommand('insertText', false, value); }, text).catch(() => {});
          await page.waitForTimeout(300);
          written = await readDraft();
        }
        // 2026-10-26：@ 没挂上也别把评论整条丢掉——正文在就发；只是记一笔，下次不再以为 @ 成功。
        if (hasText(written) && !hasMention(written)) { this.lastMention = false; this.lastOpenDiagnostic = { ...(this.lastOpenDiagnostic || {}), mentionMissing: true }; }
        if (!hasText(written)) {
          // 2026-10-26：清掉半截草稿再报错，别让下一次评论被「输入框已有草稿」挡住。
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          const excerpt = String(written.inner || written.content || '').replace(/\s+/g, ' ').slice(0, 40);
          throw new Error(`评论正文没有完整进入输入框，未发布。（框里读到：${excerpt || '空'}；${[...String(written.inner || '')].length} 字 vs 正文 ${[...text].length} 字）`);
        }
        // 2026-10-26 19:55：@ 必须整块挂在开头。10-25 旧评论的 DOM 是 <a href="/user/…"><span id="@测试用小猫">…</span></a>；
        // 今天发出去的两条是纯文本「@测试用…小猫」，实体被劈开，平台照收但不会通知任何人。这条检查就是挡这个。
        if (this.lastMention) {
          const flat = normalize(String(written.inner || written.content || ''));
          const head = normalize('@' + MENTION_NAME);
          if (!flat.startsWith(head)) {
            await page.keyboard.press('Control+A').catch(() => {});
            await page.keyboard.press('Backspace').catch(() => {});
            throw new Error(`评论 @ 没有挂成整块（草稿开头读到：${flat.slice(0, 24) || '空'}），未发布。`);
          }
        }
        // 2026-10-26：发送前确认焦点还在评论框，否则可能把正文送去别处。
        const focused = await editor.evaluate(element => element === document.activeElement || element.contains(document.activeElement)).catch(() => false);
        if (!focused) await editor.focus().catch(() => {});
        const send = root.locator(SEND);
        await send.waitFor({ state: 'visible', timeout: 3_000 }); stop(signal);
        await authorized('monitor'); await this.gate(signal); await verifySameWork();
        const witnessId = operation.operationId;
        await send.evaluate((element, token) => { const entries = window.__deepseekCommentInputs ??= Object.create(null), entry = { dispatched: false }; const witness = event => { if (event.isTrusted && (event.target === element || element.contains(event.target))) entry.dispatched = true; }; document.addEventListener('click', witness, true); entry.cleanup = () => document.removeEventListener('click', witness, true); entries[token] = entry; }, witnessId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekCommentInputs?.[token]?.dispatched === true, witnessId);
        cleanupWitness = () => page.evaluate(token => { const entry = window.__deepseekCommentInputs?.[token]; entry?.cleanup(); if (window.__deepseekCommentInputs) delete window.__deepseekCommentInputs[token]; }, witnessId).catch(() => {});
        if (await inputDispatched()) throw new Error('等待期间已发生发布输入，未再点击一次。');
        await authorized('before-click'); releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终评论输入未取得可释放的本机许可。');
        stop(signal); this.record(operation); receiptWritten = true; clicked = true;
        await send.click({ timeout: 2_000, noWaitAfter: true }); releaseDispatch?.(); releaseDispatch = null;
        dispatched = await inputDispatched(); if (!dispatched) throw new Error('没有核对到真实发布输入，评论结果需要核对。');
        let commentId = null;
        for (let attempt = 0; attempt < 40 && !commentId; attempt++) { stop(signal); await page.waitForTimeout(300); commentId = await page.evaluate(findPostedComment, { text, beforeIds }); }
        if (!commentId) { await this.closeCommentPanel(page); this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() }); return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '已尝试一次发布，但没有同作品的新本人评论编号回读；请核对，未重试。' }; }
        await this.closeCommentPanel(page);
        const result = { confirmed: true, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, commentId };
        this.record({ ...operation, status: 'confirmed', completedAt: new Date().toISOString(), commentId });
        return result;
      }, { signal, autonomousRunId });
    } catch (error) {
      if (clicked || dispatched) { try { this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() }); } catch { /* 保留原始发布收据，未自动重试。 */ } return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '发布输入后的结果不明，请人工核对，未再次点击。' }; }
      if (receiptWritten) this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
      return { confirmed: false, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, reason: error.message || '评论发布前检查未通过，草稿已保留。' };
    } finally { releaseDispatch?.(); try { await cleanupWitness?.(); } catch { /* 清理失败不影响发布收据。 */ } release(); }
  }
  async close() { if (this.ownsController) await this.controller.close(); }
}
