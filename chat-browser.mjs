import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserController } from './core.mjs?v=9';
import { messageFingerprint } from './chat-message.mjs';
import { MessageIdentityTracker } from './message-tracker.mjs';
export { MessageIdentityTracker } from './message-tracker.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const hash = value => createHash('sha256').update(value).digest('hex');
const stop = signal => signal?.throwIfAborted();
const readableDraft = value => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

export function analyzeConversationDay(snapshot, { now = Date.now, confirmedHistory = [], greetingAsReply = false } = {}) {
  const current = typeof now === 'function' ? now() : now, today = localDay(current), yesterday = localDay(current - 86_400_000);
  const recipientId = snapshot?.conversation?.id || snapshot?.contact?.id;
  if (typeof recipientId === 'string' && recipientId.trim() && confirmedHistory.some(item => item?.confirmed === true && item.recipientId === recipientId && typeof item.messageId === 'string' && item.messageId.trim() && item.date === today && Number.isFinite(Date.parse(item.at)) && localDay(Date.parse(item.at)) === today && Date.parse(item.at) <= current)) return { status: 'already-sent', reason: '共同账本已确认今天向这位好友发过消息。' };
  const evidence = snapshot?.dayEvidence;
  // 2026-10-30 主人定：不再要求「会话最新端已核实 / chronology」这类读不出来的凭据——它让
  // 测试用小猫永远停在 date-unknown。现在只要有会话、没登录/验证、有消息数组就能判。
  if (snapshot?.blocked || snapshot?.loginRequired || snapshot?.verificationRequired || !recipientId || !Array.isArray(snapshot.messages) || (evidence && !Number.isFinite(Date.parse(evidence.observedAt)))) return { status: 'date-unknown', reason: '会话没有读到，或登录/验证状态不明。' };
  const messages = snapshot.messages;
  if (messages.some(item => !['incoming', 'outgoing'].includes(item.sender || item.direction) || item.pending || item.failed)) return { status: 'date-unknown', reason: '会话含方向不明或未确认的消息，未自动问候。' };
  const dayOf = item => {
    const kind = item.dateEvidence?.kind;
    if (kind === 'today') return today;
    if (kind === 'yesterday') return yesterday;
    if (kind === 'before-yesterday') return localDay(current - 2 * 86_400_000);
    const raw = String(item.dateEvidence?.raw ?? item.sentAt ?? item.timestamp ?? '').trim();
    const monthDay = /^(\d{1,2})[-/月](\d{1,2})日?(?:$|[ T\s])/.exec(raw);
    if (monthDay && kind === 'month-day') {
      const year = Number(today.slice(0, 4));
      const guess = `${year}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
      return guess <= today ? guess : `${year - 1}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
    }
    const date = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:$|[ T\s])/.exec(raw);
    if (!date) return null;
    const padded = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
    if (!Number.isFinite(Date.parse(padded + 'T00:00:00+08:00')) || localDay(Date.parse(padded + 'T00:00:00+08:00')) !== padded) return null;
    if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return Number.isFinite(Date.parse(raw)) ? localDay(Date.parse(raw)) : null;
    return padded;
  };
  // 2026-10-30 主人定的规则只有一条：今天没发过消息，就直接问候。
  // 证据就看会话里的时间分隔条（刚刚 / 09:01 / 昨天 14:45），不再纠缠「最新端是否已核实」。
  const lastOutgoing = messages.findLastIndex(item => (item.sender || item.direction) === 'outgoing');
  if (lastOutgoing >= 0 && dayOf(messages[lastOutgoing]) === today) return { status: 'already-sent', reason: '当前会话已读到今天真实发出的消息。' };
  if (!messages.length) return { status: 'eligible', reason: '会话里还没有消息，今天没发过。' };
  const lastDay = dayOf(messages[messages.length - 1]);
  if (!lastDay) return { status: 'date-unknown', reason: '最后一条消息的时间标签认不出来，不自动问候。' };
  if (lastDay < today) return { status: 'eligible', reason: `最后一条消息是 ${lastDay}，今天还没发过。` };
  return { status: 'eligible', reason: '对方今天留了话，今天还没发过——问候充当回应。' };
}

// 只采集会话身份和未读标识，不读取预览或其他会话正文。
export function readContactDom() {
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  // 2026-10-24：实测会话列表会把 uid（纯数字）渲染进标题节点，真实昵称可能在 title 或另一个节点里。
  const looksNumeric = value => /^\d{6,}$/.test(value || '');
  const nameOf = row => {
    const known = clean(row.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]')?.textContent);
    if (known && !looksNumeric(known)) return known;
    const titled = clean(row.getAttribute('title') || row.querySelector('[title]')?.getAttribute('title') || '');
    if (titled && !looksNumeric(titled) && titled !== known) return titled;
    return known;
  };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  return [...(dialog?.querySelectorAll('[data-e2e="conversation-item"]') ?? [])].map((row, index) => {
    const displayName = nameOf(row);
    return {
      index,
      displayName,
      nameIsNumeric: looksNumeric(displayName),
      nativeId: row.getAttribute('data-conversation-id') || row.getAttribute('data-conversation-short-id') || null,
      avatar: resource(row.querySelector('.commonIMAvataravatarContainer img,img')?.getAttribute('src')),
      unread: Boolean(row.querySelector('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')),
      isGroup: Boolean(row.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]')),
    };
  });
}

export function readChatBlockers() {
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const labels = [...document.querySelectorAll('body *')].filter(e => !e.childElementCount && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]'));
  return {
    loginRequired: labels.some(e => /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(e.textContent)),
    verificationRequired: labels.some(e => /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(e.textContent)),
  };
}

export function readConversationDom() {
  const clean = value => (value ?? '').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  // 2026-10-30 主人定：抖音会话里的时间分隔条本身就是最硬的证据——「刚刚」「09:01」是今天，
  // 「昨天 14:45」是昨天。原来的正则只认「今天」和完整年月日，「刚刚」「昨天」全落进 unknown，
  // 判定就永远卡在 date-unknown（测试用小猫就是这条）。
  const datedKind = value => {
    const raw = clean(value);
    if (!raw) return 'unknown';
    if (/^(?:刚刚|今天)(?:\s|$)/.test(raw)) return 'today';
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return 'today';
    if (/^昨天/.test(raw)) return 'yesterday';
    if (/^前天/.test(raw)) return 'before-yesterday';
    if (/^\d{1,2}[-/月]\d{1,2}日?(?:\s|$)/.test(raw)) return 'month-day';
    if (/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(raw)) return 'absolute';
    return 'unknown';
  };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  const headers = [...(dialog?.querySelectorAll('.StackLayoutStackChatHeaderuser,[data-e2e="chat-header"]') ?? [])].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const root = header?.closest('.StackLayoutpagespageRoot,[data-e2e="chat-page"]');
  const displayName = clean(header?.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent);
  const avatar = resource(header?.querySelector('img')?.getAttribute('src'));
  let timestamp = null;
  const messages = [];
  const nodes = root?.querySelectorAll('.MessageBoxTimetimeLayout,time,[data-e2e="msg-item-content"]') ?? [];
  const list = root?.querySelector('.messageMessageListlist');
  let newestFirst = false, chronologySource = list ? 'message-list-order-unverified' : 'dom-order';
  if (list) {
    const style = getComputedStyle(list);
    let verticallyFlipped = false;
    try { verticallyFlipped = style.transform !== 'none' && new DOMMatrix(style.transform).d < 0; } catch {}
    newestFirst = verticallyFlipped || style.flexDirection === 'column-reverse';
    if (newestFirst) chronologySource = verticallyFlipped ? 'message-list-vertical-transform' : 'message-list-column-reverse';
  }
  for (const node of nodes) {
    if (!node.matches('[data-e2e="msg-item-content"]')) { timestamp = node.getAttribute('datetime') || clean(node.textContent) || timestamp; continue; }
    const box = node.closest('.messageMessageBoxmessageBox,[data-e2e="message-row"]') || node;
    const fromMe = Boolean(node.closest('.MessageBoxContentisFromMe,.messageMessageBoxisFromMe,[data-direction="outgoing"]'));
    const direction = fromMe ? 'outgoing' : box.matches('.messageMessageBoxmessageBox,[data-e2e="message-row"]') ? 'incoming' : 'unknown';
    const textNode = node.querySelector('.MessageItemTextcontainer,[data-e2e="message-text"]');
    const emoji = node.querySelector('.MessageItemEmojiemojiBox');
    const share = node.querySelector('.MessageItemShareAwemecontainer');
    const kind = textNode ? 'text' : emoji ? 'emoji' : share ? 'video' : 'unsupported';
    const text = textNode ? clean(textNode.innerText || textNode.textContent) : '';
    let media = null;
    if (emoji) {
      const images = [...emoji.querySelectorAll('img')].map(image => ({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt') || image.getAttribute('aria-label') || image.getAttribute('title')) || null }));
      const label = clean(emoji.getAttribute('aria-label') || emoji.getAttribute('title')) || images.map(image => image.label).filter(Boolean).join(' ') || null;
      media = { type: 'emoji', label, images, requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (share) {
      let url = null, videoId = null;
      for (const link of share.querySelectorAll('a[href]')) {
        try { const candidate = new URL(link.getAttribute('href'), location.href); const match = /^\/video\/(\d+)\/?$/.exec(candidate.pathname);
          if (candidate.protocol === 'https:' && /^(?:www\.)?douyin\.com$/.test(candidate.hostname) && match) { videoId = match[1]; url = `https://www.douyin.com/video/${videoId}`; break; }
        } catch {}
      }
      const title = clean(share.querySelector('.MessageItemShareAwemetitle,.MessageItemShareAwemedesc,[data-e2e="shared-video-title"]')?.textContent) || null;
      const author = clean(share.querySelector('.MessageItemShareAwemeauthorName,[data-e2e="shared-video-author"]')?.textContent) || null;
      const cover = share.querySelector('.MessageItemShareAwemeawemeContainer,img:not(.MessageItemShareAwemephotosTag):not(.MessageItemShareAwemeauthorAvatar)');
      media = { type: 'shared-work', videoId, url, title, author, isPhotoGallery: Boolean(share.querySelector('.MessageItemShareAwemephotosTag')),
        images: cover ? [{ src: cover.currentSrc || cover.getAttribute('src') || '', label: clean(cover.getAttribute('alt')) || null }] : [],
        requiresVisual: true, understandingScope: 'card-cover-and-dom-metadata', publicUrlSource: url ? 'dom-link' : null, canResolveByOpeningCard: true };
    }
    const indexNode = node.closest('[data-index]');
    const rawOrder = indexNode?.getAttribute('data-index');
    const order = rawOrder !== null && rawOrder !== undefined && /^\d+$/.test(rawOrder) ? Number(rawOrder) : null;
    const nativeId = box.getAttribute('data-message-id') || box.getAttribute('data-msg-id') || node.getAttribute('data-message-id') || null;
    const ownTimestamp = box.getAttribute('data-sent-at') || box.getAttribute('data-timestamp') || node.getAttribute('data-sent-at');
    const ownTimeNode = box.querySelector('.MessageBoxTimetimeLayout,time');
    const ownTime = ownTimeNode?.getAttribute('datetime') || clean(ownTimeNode?.textContent);
    // 2026-10-30：倒序列表里也退回分组时间标签——「昨天 14:45」「刚刚」就写在分隔条上。
    // 原来这里对 newestFirst 直接给 null，日期证据就永远是 unknown，判定永远过不去。
    const dated = ownTimestamp || ownTime || timestamp || null;
    messages.push({ nativeId, direction, sender: direction, text, kind, media, timestamp: ownTimestamp || timestamp, order, domIndex: order, domPosition: messages.length, orderMode: list ? 'relative' : 'absolute',
      dateEvidence: { raw: dated || timestamp || '', kind: datedKind(dated), source: ownTimestamp ? 'message-attribute' : ownTime ? 'message-time' : !newestFirst ? 'group-label' : 'unverified-group-label' },
      failed: Boolean(box.querySelector('[class*="sendFail"],[class*="SendFail"],[data-e2e="message-failed"]')),
      pending: Boolean(box.querySelector('[class*="sending"],[class*="Sending"],[data-e2e="message-pending"]')) });
  }
  const emptyTodayVerified = messages.length === 0 && [...(root?.querySelectorAll('[data-e2e="empty-conversation"],[class*="empty" i]') ?? [])].some(element => visible(element) && /^今天(?:还)?(?:暂无|没有|尚无)消息[。！!\s]*$/.test(clean(element.textContent)));
  const latestEndVerified = emptyTodayVerified || newestFirst && messages.some(message => message.domIndex === 0);
  if (list) messages.forEach(message => { message.latestEndVerified = latestEndVerified; });
  if (newestFirst) {
    messages.reverse();
    let previousTime = null;
    messages.forEach((message, index) => { message.order = index; message.timestamp ??= previousTime; previousTime = message.timestamp; });
  }
  const loading = [...(root?.querySelectorAll('[class*="loading"],[class*="Loading"],[aria-busy="true"]') ?? [])].some(visible);
  const historyStartVerified = [...(root?.querySelectorAll('[data-e2e="history-start"],[class*="no-more-tip"],[class*="noMoreTip"]') ?? [])].some(element => visible(element) && /没有更多消息|暂无更多消息|已显示全部消息/.test(clean(element.textContent)));
  return { displayName, avatar, messages, loading, latestEndVerified, emptyTodayVerified, historyStartVerified, observedAt: new Date().toISOString(), chronology: list && !newestFirst && !emptyTodayVerified ? 'unknown' : 'oldest-first', chronologySource, sourceDomOrder: newestFirst ? 'newest-first' : list ? 'unknown' : 'oldest-first' };
}

export function readChatIdentityDom() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const src = header?.querySelector('img')?.getAttribute('src');
  let avatar = ''; try { avatar = new URL(src, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch {}
  return { displayName: header?.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent.trim(), avatar };
}

// 会话列表去重：抖音同一批会话会被重复渲染成几十条同名行，且每行原生 id 都不一样。
// 按昵称归一化分组（去零宽字符/空白/大小写/标点差异），每组只保留一行；组内优先保留已在白名单里的那条。
export function dedupeContactRows(rawRows, preferredIds = new Set()) {
  const clean = value => String(value || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const keyOf = value => clean(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || clean(value);
  const convOf = row => `conv:${hash(row.nativeId ? `native:${row.nativeId}` : `${row.displayName}\0${row.avatar}`)}`;
  const groups = new Map();
  for (const raw of rawRows) {
    const displayName = clean(raw?.displayName);
    if (!displayName) continue;
    const row = { ...raw, displayName };
    const key = keyOf(displayName);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const kept = [];
  for (const list of groups.values()) kept.push(list.find(row => preferredIds.has(convOf(row))) ?? list[0]);
  return kept;
}

export class ChatBrowser {
  constructor({ source = 'api-chat', controller } = {}) {
    if (!['api-chat', 'dsh-chat'].includes(source)) throw new TypeError('私信入口须为 api-chat 或 dsh-chat。');
    this.controller = controller ?? new BrowserController({ source });
    // 共用观看那个 controller 时不要关它（关掉等于把整个抖音标签页关了）。
    this.sharedController = Boolean(controller);
    this.contacts = new Map();
    this.following = null;
    this.identities = new MessageIdentityTracker();
    this.mediaResources = new Map();
  }
  // 自主观看是否正在占用同一个标签页（锁文件 + 进程存活）。私信轮询不该在它跑的时候暂停视频。
  watchRoundActive() {
    try {
      const stateDir = this.controller?.limits?.()?.stateDir;
      if (!stateDir) return false;
      const owner = JSON.parse(fs.readFileSync(path.join(stateDir, 'watch-loop.lock'), 'utf8'));
      if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return false;
      try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
    } catch { return false; }
  }
  async dialog(page, signal) {
    stop(signal);
    // 2026-10-24 主人报「看完视频就再也播不动」的根因：这里原来挂了一个永久的 play 拦截器，
    // 私信面板关掉以后视频仍然一播就被 pause，自主观看下一次就判「作品被暂停」。
    // 现在只在没有自主观看时暂停一次，不挂永久监听；关面板时由 restorePage 收拾干净。
    // 2026-10-25：这句暂停是给“手动开面板别让推荐流跑走”用的，但它在分享视频播放期间也可能命中，
    // 实测会把刚点开的分享视频按停（主人看到“播一下又停”）。私信只读 DOM，不需要暂停视频，干脆不做。
    const flags = await page.evaluate(readChatBlockers);
    if (flags.loginRequired || flags.verificationRequired) return { ...flags, blocked: true };
    if (!await page.locator('[data-e2e="im-dialog"]').isVisible().catch(() => false)) {
      const entry = page.locator('[data-e2e="im-entry"]');
      try { await entry.waitFor({ state: 'visible', timeout: 20_000 }); }
      catch { throw new Error('没有找到抖音消息入口。'); }
      // 2026-10-25：推荐流在放视频时，铺满的 <video> 会挡住「消息」入口的指针事件，
      // Playwright 的 click 点 10 秒也点不到，接着三个联系人全被 pause（实测 06:37:58）。
      // 先正常点一次，被挡就直派发 DOM click（React 的 onClick 照样接得住）。
      try { await entry.click({ timeout: 8_000 }); }
      catch { await entry.evaluate(element => { const target = element.querySelector('[data-e2e="something-button"]') || element; target.click(); }).catch(() => {}); }
      await page.locator('[data-e2e="im-dialog"]').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => { throw new Error('私信面板没有打开（消息入口被视频挡住，DOM 点击也没生效）。'); });
    }
    stop(signal);
    return { ...flags, blocked: false };
  }
  // 读完/发完把私信面板关掉：面板盖着推荐流时，自主观看会把整轮判成「页面需要手动处理」。
  async restorePage(page) {
    if ((this._panelHold || 0) > 0) return;
    try {
      await page.evaluate(() => {
        if (typeof window.__deepseekChatPauseVideo === 'function') { document.removeEventListener('play', window.__deepseekChatPauseVideo, true); window.__deepseekChatPauseVideo = null; }
      }).catch(() => {});
      const close = page.locator('.StackLayoutStackTitleBarcloseImPage:visible');
      if (await close.count().catch(() => 0)) await close.last().click({ timeout: 2000 }).catch(() => {});
      await page.waitForFunction(() => {
        const visible = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
        return ![...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
      }, undefined, { timeout: 3000 }).catch(() => {});
    } catch { /* 关不上不影响已经读到的结果 */ }
  }
  async verifyFollowing(page, signal) {
    // 本人的关注名单仅在首次发现联系人时核对；后续新增联系人不会进入服务的固定白名单。
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    const my = page.locator('a').filter({ has: page.locator('span').filter({ hasText: /^我的$/ }) });
    await my.waitFor({ state: 'visible', timeout: 10_000 });
    const href = await my.getAttribute('href');
    const target = new URL(href, HOME);
    if (target.hostname !== 'www.douyin.com' || !target.pathname.startsWith('/user/')) throw new Error('本人的关注入口不符合当前网页约定。');
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-e2e="user-info-follow"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(800);
    const expectedCount = await page.locator('[data-e2e="user-info-follow"]').evaluate(element => Number(/\d+/.exec(element.textContent)?.[0] ?? 0));
    const first = page.locator('[data-e2e="user-fans-container"] .OlxToPIh').first();
    for (let attempt = 0; attempt < 3 && !await first.isVisible().catch(() => false); attempt += 1) {
      stop(signal);
      await page.locator('[data-e2e="user-info-follow"]').click();
      await first.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    }
    if (!await first.isVisible()) throw new Error('本人的关注列表未就绪，未确认联系人关系。');
    if (expectedCount > 0 && expectedCount <= 20) await page.waitForFunction(count => document.querySelectorAll('[data-e2e="user-fans-container"] .OlxToPIh').length >= count, expectedCount, { timeout: 10_000 });
    stop(signal);
    this.following = await page.evaluate(() => [...document.querySelectorAll('[data-e2e="user-fans-container"] .OlxToPIh')].map(row => ({
      displayName: row.querySelector('.Zce7SWd3 a')?.textContent.trim(),
      mutual: [...row.querySelectorAll('button')].some(button => button.textContent.trim() === '相互关注'),
    })));
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await this.dialog(page, signal);
  }
  // 2026-10-25 主人定：轮询先看右上角「消息」入口上的红数字，0 就不开面板。
  // 只读，不点开私信页；拿不准（入口没渲染/数字不是数字）就返回 count:null，让调用方照旧全读，宁慢勿漏。
  unreadCount() {
    return this.controller.withPage(async page => page.evaluate(() => {
      const entry = document.querySelector('[data-e2e="im-entry"]');
      if (!entry) return { ok: false, count: null, raw: null };
      const badge = entry.querySelector('.semi-badge-count');
      const raw = (badge?.textContent || '').trim();
      if (!raw) return { ok: true, count: 0, raw: '' };
      const match = /^(\d{1,4})\+?$/.exec(raw);
      return { ok: true, count: match ? Number(match[1]) : null, raw };
    }), {});
  }
  // 2026-10-25 主人报「反复关掉又再拉开」：一次轮询里要读/发好几步，每一步 readConversation 都会
  // 在 finally 里 restorePage 关一次面板。holdPanel() 期间不关门，最后由调用方 closePanel() 收一次。
  holdPanel() { this._panelHold = (this._panelHold || 0) + 1; }
  releasePanel() { this._panelHold = Math.max(0, (this._panelHold || 0) - 1); }
  // 只看角标、一个会话都不读的时候，别把面板留在页面上（挡住推荐流会让自主观看判 needs_user）。
  closePanel() {
    return this.controller.withPage(async (page) => { await this.restorePage(page); return { ok: true }; }, {});
  }
  async contactList(page, signal) {
    const flags = await this.dialog(page, signal);
    if (flags.blocked) return { ...flags, contacts: [] };
    await page.locator('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    if (this.following?.length === 2) await page.waitForFunction(() => document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').length >= 2, undefined, { timeout: 5000 }).catch(() => {});
    const rawRows = await page.evaluate(readContactDom);
    // 2026-10-25：同一批会话被 DOM 重复渲染时会出现几十条同名行（设置页那次 17 个「测试用小猫」）。
    // 旧写法只看原生 id，可同一人每次渲染的 id 都不一样，去重等于没做；现在先按昵称归一化分组，
    // 组内优先保留「已在白名单里」的那条，这样勾选状态不会因为换了条 id 而错位。
    const rows = dedupeContactRows(rawRows, this.preferredContactIds ?? new Set());
    const identities = rows.map(row => `conv:${hash(row.nativeId ? `native:${row.nativeId}` : `${row.displayName}\0${row.avatar}`)}`);
    if (new Set(identities).size !== identities.length || rows.some(row => !row.displayName || (!row.nativeId && !row.avatar))) throw new Error('联系人身份不完整或存在歧义，已停止读取会话。');
    const contacts = [];
    const marks = [];
    this.contacts.clear();
    for (const [index, row] of rows.entries()) {
      const id = identities[index];
      const matching = this.following?.filter(item => item.displayName === row.displayName && item.mutual) ?? [];
      const uniqueName = rows.filter(item => item.displayName === row.displayName).length === 1;
      const followed = matching.length === 1 && uniqueName ? true : null;
      const contact = { id, displayName: row.displayName, name: row.displayName, unread: row.unread, followed, isGroup: row.isGroup ? true : followed ? false : null,
        relationshipEvidence: followed ? { source: 'self-follow-list', label: '相互关注', matchedBy: 'unique-display-name', accountIdCrossChecked: false } : null };
      this.contacts.set(id, { ...contact, avatar: row.avatar });
      contacts.push(contact);
      marks.push({ index, id });
    }
    // 2026-10-30 主人报「读私信又卡住」：原写法逐行 nth(index).evaluate()，每行一次往返；locator 解析
    // 不到时默认等 30 秒，一行失败会把整串拖成几分钟，读一次会话能卡到时间超时。改成一次 evaluate
    // 按 DOM 顺序批量打标记，行为和结果都不变（标记只是给 select() 找行的锚点），失败照旧不影响读取。
    try {
      await page.evaluate(list => {
        const nodes = [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]')];
        for (const item of list) nodes[item.index]?.setAttribute('data-deepseek-chat-id', item.id);
      }, marks);
    } catch { /* 标记失败不影响读取 */ }
    return { ...flags, contacts };
  }
  listContacts({ signal, verifyFollowing = this.following === null, preferredIds = [] } = {}) {
    this.preferredContactIds = new Set(Array.isArray(preferredIds) ? preferredIds : []);
    return this.controller.withPage(async page => {
      const initial = await this.dialog(page, signal);
      if (initial.blocked) return { ...initial, contacts: [] };
      if (verifyFollowing) await this.verifyFollowing(page, signal);
      return this.contactList(page, signal);
    }, { signal });
  }
  async select(page, recipientId, signal) {
    if (typeof recipientId !== 'string' || !/^conv:[a-f0-9]{64}$/.test(recipientId)) throw new TypeError('需要已发现的精确联系人 ID。');
    const flags = await this.contactList(page, signal);
    if (flags.blocked) return { flags };
    const contact = this.contacts.get(recipientId);
    if (!contact || contact.isGroup === true) throw new Error('指定联系人已变化或属于群聊，已停止操作。');
    const row = page.locator(`[data-e2e="conversation-item"][data-deepseek-chat-id="${recipientId}"]`);
    if (await row.count() !== 1) throw new Error('指定会话不是唯一匹配，已停止操作。');
    const current = await page.evaluate(readChatIdentityDom);
    if (current.displayName !== contact.displayName) {
      const back = page.locator('[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn');
      if (current.displayName && await back.count() === 1) {
        await back.click();
        await this.contactList(page, signal);
      }
      // 2026-10-30：click 不带 timeout 时默认等 30 秒，会话行被推荐流视频挡住就是这样卡住的。
      // 先 5 秒试一次，点不到就直接派发 DOM click（和 dialog() 打开消息面板同一种兜底）。
      try { await row.click({ timeout: 5000 }); }
      catch { await row.evaluate(element => element.click()).catch(() => {}); }
      await page.waitForFunction(expected => {
        const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
        const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
        if (headers.length !== 1) return false;
        const header = headers[0];
        const name = header.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent.trim();
        let avatar = ''; try { avatar = new URL(header.querySelector('img')?.getAttribute('src'), location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch {}
        return name === expected.displayName;
      }, { displayName: contact.displayName }, { timeout: 10_000 });
      await page.waitForTimeout(300);
    }
    const identity = await page.evaluate(readChatIdentityDom);
    // 2026-10-24：头像链接带签名、每次可能不同，不能拿它当身份。身份以 data-deepseek-chat-id 为准，
    // 这里只核对标题（昵称）；头像不一致只记下来，不再中止。
    if (identity.displayName !== contact.displayName) throw new Error('会话标题回读与联系人不一致，已停止操作。');
    stop(signal);
    return { contact, flags };
  }
  async stableConversation(page, contact, signal) {
    let previous;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      stop(signal);
      const current = await page.evaluate(readConversationDom);
      if (current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('读取前会话身份发生变化。');
      const signature = JSON.stringify(current.messages);
      if (!current.loading && previous === signature) return current;
      previous = current.loading ? undefined : signature;
      await page.waitForTimeout(150);
    }
    throw new Error('指定会话的消息列表仍在加载或变化，未确认正文快照。');
  }
  publicMessages(recipientId, rawRows) {
    const rows = rawRows.map(row => {
      if (!row.media) return row;
      const { images = [], ...media } = row.media;
      const resources = images.filter(image => image.src).map(image => {
        const ref = `media:${hash(image.src.startsWith('data:') ? image.src : (() => { try { return new URL(image.src).pathname; } catch { return image.src; } })())}`;
        this.mediaResources.set(ref, { src: image.src, label: image.label ?? null, recipientId });
        return { resourceRef: ref, label: image.label ?? null };
      });
      return { ...row, media: { ...media, imageCount: resources.length, resources } };
    });
    const identified = this.identities.identify(recipientId, rows);
    return identified.map(row => row.media?.type === 'shared-work' ? { ...row, media: { ...row.media,
      safeOpenSelector: `[data-deepseek-message-id="${row.id}"] .MessageItemShareAwemecontainer` } } : row);
  }
  async markMessages(page, messages) {
    await page.evaluate(mapping => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
      const header = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
      const root = header.length === 1 ? header[0].closest('.StackLayoutpagespageRoot,[data-e2e="chat-page"]') : null;
      const nodes = [...(root?.querySelectorAll('[data-e2e="msg-item-content"]') ?? [])];
      if (nodes.length !== mapping.length || new Set(mapping.map(item => item.domPosition)).size !== nodes.length) throw new Error('消息窗口已经改变。');
      for (const item of mapping) {
        if (!Number.isSafeInteger(item.domPosition) || item.domPosition < 0 || item.domPosition >= nodes.length) throw new Error('消息 DOM 位置不可核对。');
        nodes[item.domPosition].setAttribute('data-deepseek-message-id', item.id);
      }
    }, messages.map((message, index) => ({ id: message.id, domPosition: message.domPosition ?? index })));
  }
  readConversation(recipientId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('读取正文需要这个指定联系人的明确授权。'));
    return this.controller.withPage(async page => {
      try {
        const { contact, flags } = await this.select(page, recipientId, signal);
        if (flags.blocked) return { ...flags, conversation: null, contact: null, messages: [] };
        const raw = await this.stableConversation(page, contact, signal);
        if (raw.displayName !== contact.displayName || raw.avatar !== contact.avatar) throw new Error('读取前会话身份发生变化。');
        const { avatar, ...publicContact } = contact;
        const messages = this.publicMessages(recipientId, raw.messages);
        await this.markMessages(page, messages);
        return { ...flags, conversation: { id: contact.id, displayName: contact.displayName }, contact: publicContact,
          messages, dayEvidence: { observedAt: raw.observedAt, latestEndVerified: raw.latestEndVerified, chronology: raw.chronology, historyStartVerified: raw.historyStartVerified, emptyTodayVerified: raw.emptyTodayVerified } };
      } finally { await this.restorePage(page); }
    }, { signal });
  }
  captureMessage(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('查看画面需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      try {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, frames: [], imageStatus: '登录或验证画面未采集。' };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (!message?.media || message.unsupported) throw new Error('该消息没有已识别的表情或分享作品画面。');
      await this.markMessages(page, messages);
      const frame = page.locator(`[data-e2e="im-dialog"] [data-deepseek-message-id="${messageId}"]`).locator('.MessageItemEmojiemojiBox,.MessageItemShareAwemecontainer');
      if (await frame.count() !== 1) throw new Error('没有唯一的指定消息画面。');
      const current = await page.evaluate(readChatIdentityDom);
      const protectedScreen = await page.evaluate(readChatBlockers);
      if (protectedScreen.loginRequired || protectedScreen.verificationRequired) return { ...protectedScreen, frames: [], imageStatus: '登录或验证画面未采集。' };
      if (current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('截取画面前会话身份发生变化。');
      stop(signal);
      const rectangle=await frame.boundingBox();
      const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
      if(!rectangle) throw new Error('指定消息画面目前不可见，未采集。');
      const clip={x:Math.max(0,rectangle.x),y:Math.max(0,rectangle.y),width:Math.min(viewport.width,rectangle.x+rectangle.width)-Math.max(0,rectangle.x),height:Math.min(viewport.height,rectangle.y+rectangle.height)-Math.max(0,rectangle.y)};
      if(clip.width<2||clip.height<2) throw new Error('指定消息不在当前视口内，未采集其他区域。');
      const unobstructed=await frame.evaluate(element=>{const r=element.getBoundingClientRect(),x=Math.max(1,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(1,Math.min(innerHeight-1,r.y+r.height/2));return element.contains(document.elementFromPoint(x,y));});
      if(!unobstructed) throw new Error('指定消息被其他界面遮挡，未采集。');
      // 倒转的虚拟列表不能依赖 locator 的自动滚动稳定等待；只截取当前消息的可见矩形。
      const data = await page.screenshot({ type:'jpeg',quality:70,clip,timeout:5000 });
      const afterRectangle=await frame.boundingBox();
      if(!afterRectangle||['x','y','width','height'].some(key=>Math.abs(afterRectangle[key]-rectangle[key])>1)) throw new Error('截图期间指定消息位置改变，画面已丢弃。');
      const afterIdentity=await page.evaluate(readChatIdentityDom);
      const afterProtection=await page.evaluate(readChatBlockers);
      if(afterProtection.loginRequired||afterProtection.verificationRequired) return {...afterProtection,frames:[],imageStatus:'截图期间出现登录或验证，本次画面已丢弃。'};
      if(afterIdentity.displayName!==contact.displayName || afterIdentity.avatar!==contact.avatar) throw new Error('截图期间会话身份发生变化，画面已丢弃。');
      const afterRaw=await this.stableConversation(page,contact,signal);
      const afterMessages=this.publicMessages(recipientId,afterRaw.messages);
      const afterMessage=afterMessages.find(item=>item.id===messageId);
      const mediaIdentity=value=>JSON.stringify([value?.sender,value?.kind,value?.text,value?.media?.type,value?.media?.resources,value?.media?.label,value?.media?.title,value?.media?.videoId]);
      if(!afterMessage || mediaIdentity(afterMessage)!==mediaIdentity(message)) throw new Error('截图期间指定消息发生变化，画面已丢弃。');
      return { ...flags, conversation: { id: recipientId, displayName: contact.displayName }, messageId,
        media: message.media, understandingScope: message.media.understandingScope,
        frames: [{ mimeType: 'image/jpeg', data: data.toString('base64') }], imageStatus: '已采集指定消息的实际画面，尚需支持图像的模型读取。' };
      } finally { await this.restorePage(page); }
    }, { signal });
  }
  openSharedVideo(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('打开分享作品需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      try {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, opened: false };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (message?.media?.type !== 'shared-work') throw new Error('该消息不是已识别的分享作品卡片。');
      if (message.media.url) return { ...flags, opened: false, videoId: message.media.videoId, url: message.media.url, source: 'dom-link' };
      await this.markMessages(page, messages);
      const card = page.locator(`[data-e2e="im-dialog"] ${message.media.safeOpenSelector}`);
      if (await card.count() !== 1) throw new Error('没有唯一的指定分享卡片。');
      const beforeUrl = new URL(page.url());
      const beforeId = /^\/video\/(\d+)\/?$/.exec(beforeUrl.pathname)?.[1] || beforeUrl.searchParams.get('modal_id') || null;
      const pop = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
      stop(signal);
      const parentSource = this.controller.source?.startsWith('dsh') ? 'dsh' : 'api';
      const decision = this.controller.limits().beforeAction(parentSource, 'douyin_open_video');
      if (!decision.allowed) throw new Error(decision.reason || '当前时间不允许打开分享作品。');
      let popup, target = page;
      try {
        await card.click();
        popup = await pop;
        target = popup ?? page;
        if (popup) await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await target.waitForFunction(({ beforeId, newPopup }) => {
          const observed = new URL(location.href);
          const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
          return /^\d+$/.test(id || '') && (newPopup || id !== beforeId);
        }, { beforeId, newPopup: Boolean(popup) }, { timeout: 5000 }).catch(() => {});
        const observed = new URL(target.url());
        const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
        if (observed.protocol !== 'https:' || !/^(?:www\.)?douyin\.com$/.test(observed.hostname) || !/^\d+$/.test(id || '')) return { ...flags, opened: true, videoId: null, url: null, reason: '实际打开页面没有可核实的公开作品 ID。' };
        if (!popup && id === beforeId) return { ...flags, opened: true, videoId: null, url: null, reason: '点击后没有核实新的作品页面，未采用原详情页的作品 ID。' };
        return { ...flags, opened: true, videoId: id, url: `https://www.douyin.com/video/${id}`, source: 'actual-opened-page-url', isPhotoGallery: message.media.isPhotoGallery };
      } finally {
        if (!popup) { popup = await pop; if (popup) target = popup; }
        // 2026-10-25 主人实测：手动点卡片，详情/浮层里的视频是**自动播放**的。
        // 这里原来会把它按暂停，导致后面三次采样都是 t=4.03 同一帧。现在不再动播放状态。
        if (popup) await popup.close().catch(() => {});
      }
      } finally { await this.restorePage(page); }
    }, { signal });
  }
  sendMessage(recipientId, message, { allowed = false, expectedMessageIds, expectedMessageContent, signal: parentSignal, authorize, followUp = false } = {}) {
    if (allowed !== true) return Promise.reject(new Error('发送需要这个指定联系人的明确授权。'));
    if (typeof message !== 'string' || !message.trim() || [...message].length > 1000) return Promise.reject(new TypeError('发送内容须为 1 到 1000 字的非空文字。'));
    if (authorize !== undefined && (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function')) return Promise.reject(new TypeError('主动问候需要本机许可检查和最终短输入控制。'));
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (authorize && await authorize({ phase, recipientId }) !== true) throw new Error('主动问候许可已撤回，未继续发送。'); stop(signal); };
    return this.controller.withPage(async page => {
      await authorized('prepare');
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, confirmed: false, deliveryUncertain: false };
      const before = await page.evaluate(readConversationDom);
      const initialMessages = this.publicMessages(recipientId, before.messages);
      const expected = expectedMessageIds ?? initialMessages.map(item => item.id);
      const contentOf = messages => messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
      const expectedContent = expectedMessageContent ?? contentOf(initialMessages);
      // 2026-10-24 21:35：以前这里要求「整窗消息 id + 指纹」与调用方读到的完全一致。实测抖音消息行没有稳定原生 id，
      // 同一句「回我」重复十几条时窗口重叠无法唯一对齐，每次读都会重新分配 id → 永远「水位已变化」、一条都发不出去。
      // 现在只守住真正重要的三条：会话身份对、没有方向不明的消息、对方最后一条还是新消息（可选）。
      const tailOf = messages => messages.slice(-8);
      const tailSignature = messages => JSON.stringify(tailOf(messages).map(item => [item.direction, messageFingerprint(item)]));
      if (!Array.isArray(expected) || !Array.isArray(expectedContent) || initialMessages.some(item => item.direction === 'unknown')) return { confirmed: false, deliveryUncertain: false, reason: '私信会话状态不明，未填写或发送回复。' };
      const replyWithState = Array.isArray(expectedMessageIds) || Array.isArray(expectedMessageContent);
      if (replyWithState && !followUp && initialMessages.length && initialMessages.at(-1).direction !== 'incoming') return { confirmed: false, deliveryUncertain: false, reason: '对方最后一条不是新消息，未发送。' };
      const baselineTail = tailSignature(initialMessages);
      const outgoingBefore = initialMessages.filter(item => item.direction === 'outgoing').length;
      const receipt = { conversation: { id: contact.id, displayName: contact.displayName }, contact: { id: contact.id, name: contact.displayName } };
      const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (await editor.count() !== 1) throw new Error('没有唯一的私信文字输入框。');
      if (await editor.locator('img,video,audio,[data-slate-void="true"]').count()) throw new Error('当前会话已有图片或语音草稿，已停止发送以保留原内容。');
      const staleDraft = readableDraft(await editor.innerText());
      // 中止过一次的上一次回复会以草稿留在输入框里（截图里那条 [草稿] [自动回复]…）。
      // 直接改 textContent 清不掉 Slate 的内部状态，fill 会变成"再追加一份"，所以用真键盘全选删除再复核。
      if (staleDraft && !staleDraft.startsWith('[自动回复]')) throw new Error('当前会话已有别人的草稿，已停止发送以保留原内容。');
      if (staleDraft) {
        await editor.click({ timeout: 3000 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.waitForTimeout(150);
        const left = readableDraft(await editor.innerText());
        if (left) throw new Error(`旧草稿没能清掉（还剩 ${left.length} 字），未发送。`);
      }
      let clicked = false, monitoring = false, monitor, polling, releaseDispatch;
      const witnessId = `chat-${hash(`${recipientId}:${Date.now()}:${Math.random()}`)}`;
      try {
        await editor.fill(message);
        stop(signal);
        const ready = await page.evaluate(readConversationDom);
        const draftNow = readableDraft(await editor.innerText());
        // 2026-10-24 21:45：失败信息带上具体差在哪一步，免得又只能看到一句"不一致"。
        if (ready.displayName !== contact.displayName) throw new Error(`发送前会话标题不一致（读到「${ready.displayName || '空'}」，应为「${contact.displayName}」）。`);
        if (draftNow !== readableDraft(message)) throw new Error(`发送前输入文字回读不一致（读到 ${draftNow.length} 字，应为 ${readableDraft(message).length} 字：${JSON.stringify(draftNow.slice(0, 40))}）。`);
        const readyMessages = this.publicMessages(recipientId, ready.messages);
        // 只比对"有没有人插话"和方向；不再比对整窗 id（会随虚拟列表重排而变）。
        if (readyMessages.some(item => item.direction === 'unknown')) throw new Error('填写回复期间出现方向不明的消息，未点击发送。');
        if (replyWithState && tailSignature(readyMessages) !== baselineTail && readyMessages.length > initialMessages.length && readyMessages.at(-1)?.direction !== 'incoming') throw new Error('填写回复期间会话被切换，未点击发送。');
        const escaped = contact.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const targetPage = page.locator('.StackLayoutpagespageRoot,[data-e2e="chat-page"]').filter({ has: page.locator('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]').filter({ hasText: new RegExp(`^${escaped}$`) }) });
        const send = targetPage.locator('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]');
        if (await send.count() !== 1) throw new Error('没有唯一的指定会话发送按钮。');
        await send.evaluate((button, token) => {
          const entries = window.__deepseekChatInputs ??= Object.create(null), entry = { dispatched: false };
          const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; };
          document.addEventListener('click', witness, true);
          entry.cleanup = () => document.removeEventListener('click', witness, true); entries[token] = entry;
        }, witnessId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekChatInputs?.[token]?.dispatched === true, witnessId);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          if (await editor.count() !== 1 || await send.count() !== 1 || readableDraft(await editor.innerText()) !== readableDraft(message)) throw new Error('等待期间发送按钮或草稿发生变化，未发送。');
          const current = await page.evaluate(readConversationDom), blockers = await page.evaluate(readChatBlockers);
          if (blockers.loginRequired || blockers.verificationRequired || current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('等待期间会话身份或页面许可发生变化，未发送。');
          const messages = this.publicMessages(recipientId, current.messages);
          if (messages.some(item => item.direction === 'unknown')) throw new Error('等待期间出现方向不明的消息，未发送。');
          stop(signal);
        };
        monitoring = true;
        monitor = setInterval(() => { if (polling || !monitoring) return; polling = checkPendingInput().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error); }).finally(() => { polling = null; }); }, 40);
        await checkPendingInput();
        await send.click({ trial: true, timeout: 3000 });
        stop(signal); await checkPendingInput(); await authorized('before-click');
        if (await inputDispatched()) throw new Error('等待期间已发生发送输入，未再点击一次。');
        if (authorize) { releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终输入控制没有返回可释放的许可。'); }
        stop(signal); clicked = true;
        await send.click({ timeout: 350, noWaitAfter: true });
        releaseDispatch?.(); releaseDispatch = null;
        if (!await inputDispatched()) throw new Error('没有核对到真实发送输入，结果需要核对。');
        monitoring = false; clearInterval(monitor); stop(signal);
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const after = await page.evaluate(readConversationDom);
          if (after.displayName !== contact.displayName || after.avatar !== contact.avatar) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后会话发生变化，未再次发送。' };
          const messages = this.identities.identify(recipientId, after.messages);
          const outgoing = messages.filter(item => item.direction === 'outgoing');
          const last = messages.at(-1);
          // 回读不看旧 id 集合（虚拟列表会重排）：最后一行为我方、正文一致、我方条数比发送前多一条，就算发成功。
          const sent = last && last.direction === 'outgoing' && last.text === message.trim() && outgoing.length > outgoingBefore ? last : null;
          if (sent && !sent.failed && !sent.pending) return { ...receipt, confirmed: true, messageId: sent.id, deliveryUncertain: false };
          if (sent?.failed) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '网页显示发送失败，未自动重试。' };
          stop(signal);
          await page.waitForTimeout(250);
        }
        return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '未取得新发出消息的界面回读，未自动重试。' };
      } catch (error) {
        if (!clicked) await editor.evaluate((element,own)=>{
          // 只清除本次写入的完整回复；用户已改动的草稿保留。
          const readable=value=>value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,'').trim();
          if(readable(element.innerText)===readable(own)) {
            element.textContent='';
            element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
          }
        },message).catch(()=>{});
        // 2026-10-24：原来把真实原因吞成一句「检查未通过」，日志里查不出到底卡在哪一步。
        const detail = String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 120);
        return { ...receipt, confirmed: false, deliveryUncertain: clicked, reason: clicked ? '发送动作已尝试但结果不确定，未自动重试。' : `发送前检查未通过（${detail || '原因不详'}），未点击发送。` };
      } finally {
        monitoring = false; clearInterval(monitor); releaseDispatch?.();
        await page.evaluate(token => { const entry = window.__deepseekChatInputs?.[token]; entry?.cleanup(); if (window.__deepseekChatInputs) delete window.__deepseekChatInputs[token]; }, witnessId).catch(() => {});
        await this.restorePage(page);
      }
    }, { signal });
  }
  async close() { if (!this.sharedController) await this.controller.close(); }
}
