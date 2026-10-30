import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from './playwright-runtime.mjs';
import { composeFramesInPage, prepareCompositeFrames, COMPOSITE_DEFAULTS } from './frame-composite.mjs';
import { pickTopDanmaku, formatDanmaku, danmakuWithin, danmakuUrlTemplate, danmakuUrlFor } from './danmaku.mjs';
import { installFrameGrabber, composeStoryboardSheets, chooseIndices, planCells, planSheets, sampleIndices, trimToFirstPass, GRAB_DEFAULTS } from './frame-grab.mjs';
import { MemoryStore } from './memory.mjs?v=2';
import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=10';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths, resolveNodeExecutable } from './runtime-paths.mjs?v=10';
import { PersonaMemory } from './persona-memory.mjs?v=10';
import { BrowserLauncher, connectDedicatedBrowser } from './browser-launcher.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_ACTIONS=new Set(['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_play','douyin_listen']);
const processAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)throw new Error('共享视频操作锁无效。');try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const optionalRecord=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('共享视频操作记录无法读取，未操作视频。');}};
async function watchControl(directory,action,signal) {
  const file=path.join(directory,'watch-control.guard'),token=randomUUID();
  for(let attempt=0;;attempt++) {
    signal?.throwIfAborted(); let descriptor;
    try {descriptor=openSync(file,'wx',0o600);}
    catch(error){if(error.code!=='EEXIST'||attempt>=100)throw Object.assign(new Error('共享视频控制正在更新，请稍后重试。'),{status:409});await wait(20,signal);continue;}
    try {writeFileSync(descriptor,JSON.stringify({pid:process.pid,token}));}
    finally {closeSync(descriptor);}
    try{return action();}finally{if(optionalRecord(file)?.token===token)unlinkSync(file);}
  }
}
async function acquireNativeVideoLease(directory,signal) {
  const file=path.join(directory,'watch-manual.lock'),token=randomUUID();
  await watchControl(directory,()=>{
    const owner=optionalRecord(path.join(directory,'watch-loop.lock'));
    if(owner)throw Object.assign(new Error('自主观看正在运行或需要清理残留，请先停止它再手动操作视频。'),{status:409});
    const manual=optionalRecord(file);
    if(manual&&processAlive(manual.pid))throw Object.assign(new Error('另一个入口正在手动操作视频，请等待完成。'),{status:409});
    writeFileSync(file,JSON.stringify({pid:process.pid,token,kind:'native-tool'}),{mode:0o600});
  },signal);
  return ()=>watchControl(directory,()=>{const manual=optionalRecord(file);if(manual?.pid===process.pid&&manual.token===token)unlinkSync(file);});
}
const { browserProfileDir: PROFILE, browserControlDir: CONTROL } = resolveRuntimePaths();
const RECOMMEND = 'https://www.douyin.com/?recommend=1&from_nav=1';
const PORT = 9227;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function aborted(signal) { signal?.throwIfAborted(); }
async function wait(ms, signal) { await delay(ms, undefined, { signal }); }

// 2026-10-24 23:50：实测一次 douyin_chat_contacts 21:41:54 发起、到 23:43 都没返回，
// 把整个会话卡成「深度求索中 2 小时」。根因是 withPage()/execute() 的尾部就是这个控制器的
// this.queue —— 只要有一个 await 永远不 settle，后面所有抖音工具都排在它后面，整轮死锁。
// 这里给每次操作加硬超时：到点就放弃并抛出明确错误，队列照常放行。
// 超时后底层调用仍在跑（JS 取消不了），但它不再堵住队列；下次操作会重新核对页面状态。
const PAGE_DEADLINE_MS = 90_000;
const SERVICE_DEADLINE_MS = 180_000;
export function withDeadline(promise, ms, label) {
  const source = Promise.resolve(promise);
  source.catch(() => {}); // 超时之后迟到的失败不再算未处理的拒绝
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label}超过 ${Math.round(ms / 1000)} 秒没有返回，已放弃这次调用（工具卡住，不是模型慢）。`), { code: 'TOOL_TIMEOUT' })), ms);
    // 不能 unref：进程里只剩这个定时器时，Node 会直接退出，超时永远不触发（单测踩到过）。
  });
  return Promise.race([source, guard]).finally(() => clearTimeout(timer));
}

async function lock(name, signal) {
  mkdirSync(CONTROL, { recursive: true });
  const file = path.join(CONTROL, `${name}.lock`);
  const deadline = Date.now() + 35_000;
  while (true) {
    aborted(signal);
    try {
      const descriptor = openSync(file, 'wx');
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      closeSync(descriptor);
      return () => { try { unlinkSync(file); } catch { /* 已释放的锁无需处理。 */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(file, 'utf8'));
        if (!alive(owner.pid)) { unlinkSync(file); continue; }
      } catch {
        // 空锁只在超过两秒且内容再次一致时释放，给刚启动的持有者留出写入时间。
        try {
          const content=readFileSync(file,'utf8');
          if(Date.now()-statSync(file).mtimeMs>2000) {
            try { JSON.parse(content); } catch {
              if(readFileSync(file,'utf8')===content) unlinkSync(file);
            }
          }
        } catch { /* 其他进程已经释放。 */ }
      }
      if (Date.now() > deadline) throw new Error('同一入口仍在操作浏览器，请稍后重试。');
      await wait(150, signal);
    }
  }
}

async function version() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    return response.ok && /(?:Edg|Chrome)/.test((await response.json()).Browser ?? '');
  } catch { return false; }
}
async function endpoint(signal) {
  const release = await lock('launch', signal);
  try {
    const stateFile = path.join(CONTROL, 'browser.json');
    let state;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 首次运行没有状态。 */ }
    const ours = state?.profile === PROFILE && state.port === PORT;
    if (await version()) {
      // 端口是活的、状态也是我们写的那份，就直接用；pid 已经死了说明旧宿主退出但 Edge 还活着（孤儿窗口），
      // 这种情况下 CDP 依然可以驱动它，先别报错卡住。
      if (!ours || !state.ready) throw new Error('9227 端口不属于本工具的专用浏览器，请先释放端口。');
      return `http://127.0.0.1:${PORT}`;
    }
    const spawnedAt = Date.now();
    {
      const output = openSync(path.join(CONTROL, 'browser-host.log'), 'a');
      try {
        const child = spawn(resolveNodeExecutable(), [path.join(ROOT, 'browser-host.mjs'), PROFILE, CONTROL, String(PORT)], {
          detached: true, windowsHide: true, stdio: ['ignore', output, output],
        });
        child.unref();
      } finally { closeSync(output); }
    }
    const deadline = spawnedAt + 25_000;
    while (Date.now() < deadline) {
      aborted(signal);
      await wait(250, signal);
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { continue; }
      // 刚拉起来的宿主还没写状态时，文件里是上一轮的死 pid——那不是失败，继续等新的状态。
      if (typeof state.startedAt === 'number' && state.startedAt < spawnedAt) continue;
      if (!alive(state.pid)) continue;
      if (state.ready && state.profile === PROFILE && state.port === PORT && await version()) return `http://127.0.0.1:${PORT}`;
    }
    throw new Error('专用浏览器启动超时，请查看本机 browser-host.log。');
  } finally { release(); }
}

// 此函数仅读取网页 DOM 和 HTMLVideoElement，不调用抖音私有接口。
export function readPageState() {
  if(location.origin!=='https://www.douyin.com') return {
    url:null,title:null,video:null,live:false,ad:false,searchResults:[],visibleText:'',loginRequired:false,verificationRequired:false,
    unsupportedPage:true,note:'当前专用标签页已离开抖音，没有读取该页面内容。',
  };
  const visible = element => {
    const r = element.getBoundingClientRect(), s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const workId = value => {
    try { const u = new URL(value, location.href); return /\/video\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id'); } catch { return null; }
  };
  const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  const privateChatVisible=[...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
  // 2026-10-27：抖音会留预加载克隆 <video>，以前只按面积排序会选到暂停的克隆（实测 time 61 vs 正在播的 44），
  // state/capture/stay 全跟着克隆走。现在优先选正在播放且 readyState>=2 的那个，再按面积。
  const videoElements = [...document.querySelectorAll('video')].filter(e=>visible(e)&&!e.closest(privateArea)).map(element => {
    const r = element.getBoundingClientRect();
    return { element, area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) };
  }).sort((a,b) => {
    const playingA = a.element.paused === false && a.element.readyState >= 2;
    const playingB = b.element.paused === false && b.element.readyState >= 2;
    return Number(playingB) - Number(playingA) || b.area - a.area;
  });
  const element = videoElements[0]?.element;
  const text = [...document.querySelectorAll('body *')].filter(e => e.childElementCount === 0 && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]')).map(e => clean(e.innerText || e.textContent)).filter(Boolean).join('\n').slice(-9000);
  const loginRequired = /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text);
  const captchaVisible = [...document.querySelectorAll('#captcha_container,[class*="captcha"],[id*="captcha"],iframe[src*="captcha"]')].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const verificationRequired = /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text) || captchaVisible;
  // 直播间：抖音的卡片和房间页都挂着「直播中」角标。直播没有时长，模型看不出进度，直接跳过更省请求。
  const liveBadge = [...document.querySelectorAll('[data-e2e*="live"],[class*="live"][class*="badge"],[class*="LiveBadge"]')].some(e => visible(e) && /直播中|正在直播/.test(e.textContent || ''));
  // 2026-10-23：推荐流里只要有一张「直播中」的卡片，整页就会被判成直播（实测底部 y=1644 那张直播卡）。
  // 有有限时长说明当前放的是普通作品，不能因为别处的角标把它跳过。
  const live = (/(^|\n)\s*(直播中|正在直播)\s*(\n|$)/.test(text) || liveBadge) && !(Number.isFinite(element?.duration) && element.duration > 0);
  // 2026-10-28 主人定：广告也本地判，不花模型请求。只认播放器附近「广告 / 推广 / 赞助」这种小标签，
  // 不拿评论区或简介里的「广告」两个字算数，免得误划正常作品。
  const ad = (() => {
    // 2026-10-28 实测样张：「@火山引擎 广告」——广告两个字是作者行里的小标签，压在播放器左下角。
    // 所以判据是「文字正好是 广告/推广/赞助 的小标签，且矩形落在视频画面里或紧贴其下沿」，
    // 评论区、简介里的同名文字因为位置不重合不会命中。
    const vr = element?.getBoundingClientRect();
    const near = (r) => {
      if (!vr || !(vr.width > 0)) return true;
      return r.left >= vr.left - 40 && r.right <= vr.right + 60 && r.top >= vr.top - 60 && r.bottom <= vr.bottom + 320;
    };
    for (const node of document.querySelectorAll('span,div')) {
      if (node.childElementCount) continue;
      const text = (node.textContent || '').trim();
      if (!/^(广告|推广|赞助)$/.test(text)) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 8 || r.width > 160 || r.height > 40) continue;
      if (!visible(node) || !near(r)) continue;
      return true;
    }
    for (const node of document.querySelectorAll('[data-e2e*="ad"],[data-e2e*="advert"]')) {
      if (!visible(node)) continue;
      if (!/广告|推广|赞助/.test((node.textContent || '').trim())) continue;
      if (near(node.getBoundingClientRect())) return true;
    }
    return false;
  })();
  let video = null;
  if (element) {
    let container = element.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');
    if(!container) {
      container=element.parentElement;
      for(let i=0;container?.parentElement&&i<8;i++) {
        if(container.querySelector('[class*="video-info-detail"]')) break;
        container=container.parentElement;
      }
    }
    const links = [...(container?.querySelectorAll('a[href]') ?? [])].filter(e=>visible(e)&&!e.closest(privateArea));
    const id = /(?:^|\s)video_(\d+)(?:\s|$)/.exec(element.closest('[data-e2e="player-container"]')?.className??'')?.[1] || links.map(e=>workId(e.href)).find(Boolean) || workId(location.href) || null;
    const authorElement = links.find(e => /\/user\//.test(e.href)) || [...(container?.querySelectorAll('span,div')??[])].find(e=>e.childElementCount===0 && /^@/.test(clean(e.textContent)) && visible(e));
    const titleElement = container?.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[data-e2e="detail-video-info"],[class*="video-info-detail"]');
    const detailAuthor=container?.querySelector('[data-e2e="related-video"]')?.innerText?.split('\n').map(clean).find(Boolean);
    const captionAuthor=/@([^·\n]+)·/.exec(titleElement?.textContent??'')?.[1]?.trim();
    const r = element.getBoundingClientRect();
    video = { id, url: id ? `https://www.douyin.com/video/${id}` : null,
      author: clean(authorElement?.textContent).replace(/^@\s*/, '') || detailAuthor || captionAuthor || null,
      title: clean(titleElement?.getAttribute('data-e2e')==='detail-video-info'?titleElement.innerText.split('\n')[0]:titleElement?.textContent) || clean(links.find(e=>workId(e.href))?.textContent) || null,
      time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null,
      paused: element.paused, muted: element.muted, readyState: element.readyState,
      width: element.videoWidth, height: element.videoHeight,
      viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
  }
  const searchResults = [];
  if (location.pathname.startsWith('/search/')) {
    const candidates = [...document.querySelectorAll('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"],a[href*="/video/"],a[href*="modal_id="]')].filter(visible);
    const used = new Set();
    for (const candidate of candidates) {
      const anchor = candidate.matches('a') ? candidate : candidate.querySelector('a[href*="/video/"],a[href*="modal_id="]');
      const id = workId(anchor?.href) || candidate.getAttribute('data-aweme-id') || /waterfall_item_(\d+)/.exec(candidate.closest('[id^="waterfall_item_"]')?.id??'')?.[1];
      const card = candidate.closest('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]') || candidate;
      const leaves = [...card.querySelectorAll('div,span')].filter(e=>!e.childElementCount).map(e=>clean(e.textContent));
      const title = clean(card.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"]')?.textContent) || leaves.sort((a,b)=>b.length-a.length)[0] || clean(card.textContent);
      if (!title || used.has(id || title)) continue;
      used.add(id || title);
      searchResults.push({ index: searchResults.length, id: id || null, url: id ? `https://www.douyin.com/video/${id}` : null,
        title: title.slice(0,1000), author: clean(card.querySelector('a[href*="/user/"]')?.textContent).replace(/^@\s*/, '') || /@([^\n·]+)/.exec(card.innerText)?.[1]?.trim() || null });
    }
  }
  const u = new URL(location.href);
  for (const key of [...u.searchParams.keys()]) if (!['modal_id','aweme_id','recommend'].includes(key)) u.searchParams.delete(key);
  return { url: u.href, title: document.title, video, live, ad, searchResults: searchResults.slice(0,20), visibleText: text,
    loginRequired, verificationRequired, privateChatVisible, documentReadyState: document.readyState };
}

export class BrowserController {
  constructor({ source = 'api', memory, videoLimits, personaMemory } = {}) {
    if (!['api','dsh','verification','api-chat','dsh-chat'].includes(source)) throw new TypeError('不支持这个浏览器入口。');
    this.source = source; this.memory = memory; this.personaMemory = personaMemory; this.browser = null; this.page = null;
    this.queue = Promise.resolve();
    this.videoLimits = videoLimits;
    this.limitsEnabled = ['api','dsh'].includes(source);
  }
  limits() { return this.videoLimits ??= new VideoLimits(); }
  getMediaAdapter() { return this.mediaPromise??=import('./media/index.mjs?v=10').then(({MediaAdapter})=>new MediaAdapter()); }
  getForwarder() { return this.forwarderPromise??=import('./video-forward.mjs?v=10').then(({VideoForwarder})=>new VideoForwarder({videoLimits:this.limits(),source:this.source==='dsh'?'dsh':'api'})); }
  watchVideoLimits() {
    if (!this.limitsEnabled || this.cancelLimitsWatch) return;
    this.cancelLimitsWatch = this.limits().watch({ sources:[this.source], pause:()=>this.pauseForLimits() });
  }
  async checkVideoLimits(name) {
    if (!this.limitsEnabled) return;
    const decision=this.limits().beforeAction(this.source,name);
    if (!decision.allowed) {
      await this.pauseForLimits();
      throw new Error(decision.reason || '当前不在允许的刷视频时间内，请在本机设置开始一轮。');
    }
  }
  async pauseForLimits() {
    if (!['api','dsh'].includes(this.source)) return { paused:0, existingPage:false };
    let connection=this.browser, temporary=false;
    try {
      if(!connection?.isConnected()) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(CONTROL,'browser.json'),'utf8')); } catch { return {paused:0,existingPage:false}; }
        if(owner.profile!==PROFILE || owner.port!==PORT || !owner.ready || !alive(owner.pid) || !await version()) return {paused:0,existingPage:false};
        connection=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`,{timeout:3000}); temporary=true;
      }
      let paused=0,existingPage=false;
      for(const candidate of connection.contexts().flatMap(context=>context.pages())) {
        if(candidate.isClosed() || await candidate.evaluate(()=>window.name).catch(()=>'')!==`deepseek-douyin-${this.source}`) continue;
        existingPage=true;
        paused+=await candidate.evaluate(()=>{
          if(location.origin!=='https://www.douyin.com') return 0;
          let count=0;
          for(const video of document.querySelectorAll('video')) {if(!video.paused) count++;video.pause();}
          return count;
        }).catch(()=>0);
      }
      return {paused,existingPage};
    } finally { if(temporary) await connection?.close().catch(()=>{}); }
  }
  store() { return this.memory ??= new MemoryStore(resolveRuntimePaths().memoryDbPath); }
  getPersonaMemory() {
    if (!this.personaMemory) {
      this.personaMemory = new PersonaMemory({ memoryDir: path.dirname(this.memory?.dbPath || resolveRuntimePaths().memoryDbPath) });
      this.personaMemory.initialize({ importLegacy: false });
    }
    return this.personaMemory;
  }
  getChatService() {
    // 2026-10-24 21:35 主人报「看视频在第一个标签页、回私信在第二个标签页」：以前 ChatBrowser 自己 new 了一个
    // BrowserController(source='dsh-chat')，window.name 标记不同 → 另开第二个标签页，私信和观看各占一页。
    // 现在共用观看用的这个 controller：同一个标签页、同一把 tab 锁，私信和观看不会再互相踩。
    this.chatPromise??=Promise.all([import('./chat-browser.mjs?v=10'),import('./chat-service.mjs?v=10')])
      .then(([{ChatBrowser},{ChatService}])=>{const service=new ChatService({browser:new ChatBrowser({source:this.source==='dsh'?'dsh-chat':'api-chat', controller:this})});service.agent.personaMemory=this.getPersonaMemory();return service;})
      .catch(error=>{this.chatPromise=null;throw error;});
    return this.chatPromise;
  }
  getSparkService() {
    this.sparkPromise ??= Promise.all([this.getChatService(), import('./spark-service.mjs?v=10')]).then(([chat, { SparkService }]) => new SparkService({ browser: chat.browser, config: chat.config, personaMemory: this.getPersonaMemory(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.sparkPromise = null; throw error; });
    return this.sparkPromise;
  }
  getCommenter() {
    this.commenterPromise ??= import('./comment-browser.mjs?v=10').then(({ CommentBrowser }) => new CommentBrowser({ source: this.source === 'dsh' ? 'dsh' : 'api', videoLimits: this.limits(), stateDir: this.limits().stateDir })).catch(error => { this.commenterPromise = null; throw error; });
    return this.commenterPromise;
  }
  getComments() {
    this.commentsPromise ??= import('./autonomous-comments.mjs?v=10').then(({ AutonomousComments }) => new AutonomousComments({ controller: this, personaMemory: this.getPersonaMemory(), videoLimits: this.limits(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.commentsPromise = null; throw error; });
    return this.commentsPromise;
  }
  getReport() {
    this.reportPromise ??= import('./daily-report.mjs?v=10').then(({ DailyReport }) => new DailyReport({ personaMemory: this.getPersonaMemory() })).catch(error => { this.reportPromise = null; throw error; });
    return this.reportPromise;
  }
  getWatchMode() {
    this.modePromise ??= import('./watch-mode.mjs?v=10').then(({ WatchMode }) => new WatchMode({ stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' }));
    return this.modePromise;
  }
  async applyWatchMode({ minimize = false } = {}) {
    if (!['api', 'dsh'].includes(this.source) || !this.browser?.isConnected()) return { applied: false, pendingNextVideoAction: true };
    const mode = await this.getWatchMode(), pages = this.browser.contexts().flatMap(context => context.pages());
    const applied = [];
    for (const page of pages) {
      if (page.isClosed() || await page.evaluate(() => window.name).catch(() => '') !== `deepseek-douyin-${this.source}`) continue;
      const result = await mode.apply(page);
      if (minimize && mode.state().silent && result.applied) {
        try { result.window = await mode.minimizeManagedWindow(page); } catch (error) { result.window = { minimized: false, reason: error.message }; }
      }
      applied.push(result);
    }
    return { applied: applied.some(item => item.applied), pages: applied, focusRequested: false };
  }
  openBrowser({ signal } = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const release = await lock('browser-launcher', signal);
      try {
        this.browserLauncher ??= new BrowserLauncher({
          getBrowser: async currentSignal => { if (!this.browser?.isConnected()) { this.browser = await connectDedicatedBrowser(await endpoint(currentSignal), { signal: currentSignal }); this.page = null; } return this.browser; },
          getWatchState: () => { const worker = optionalRecord(path.join(this.limits().stateDir, 'watch-loop.lock')); if (!worker) return null; if (!Number.isSafeInteger(worker.pid) || worker.pid < 1 || !['api', 'dsh'].includes(worker.source) || typeof worker.runId !== 'string') throw new Error('自主观看锁无法核对，未打开或改动入口页。'); return alive(worker.pid) ? worker : null; },
        });
        return await this.browserLauncher.open({ signal });
      } finally { release(); }
    });
    this.queue = operation; return operation;
  }
  async connect(signal) {
    aborted(signal);
    if (this.browser?.isConnected() && this.page && !this.page.isClosed()) return this.page;
    if (!this.browser?.isConnected()) { this.browser = await connectDedicatedBrowser(await endpoint(signal), { signal }); this.page = null; }
    const context = this.browser.contexts()[0];
    const label = `deepseek-douyin-${this.source}`;
    for (const candidate of context.pages()) {
      if (await candidate.evaluate(() => window.name).catch(()=>'') === label) { this.page = candidate; break; }
    }
    if (!this.page || this.page.isClosed()) {
      const initial = [];
      for (const candidate of context.pages()) {
        if (candidate.isClosed() || candidate.url() !== 'about:blank') continue;
        if (await candidate.evaluate(() => !window.name && !document.body?.textContent?.trim() && document.querySelectorAll('body *').length === 0).catch(() => false)) initial.push(candidate);
      }
      this.page = initial.length === 1 ? initial[0] : await context.newPage();
    }
    this.page.setDefaultTimeout(10_000); this.page.setDefaultNavigationTimeout(25_000);
    // 2026-10-29：弹幕走接口（页面里的 canvas 读不出字），挂一次 response 钩子，
    // 每条作品第一次播放时的 /danmaku/get_v2/ 就在这儿落到 state\danmaku\<id>.json。
    this.attachDanmakuHook(this.page);
    await this.page.evaluate(name => { window.name = name; }, label);
    aborted(signal);
    if (this.page.url() === 'about:blank') {
      if(this.source.endsWith('-chat')) {
        await this.page.goto(RECOMMEND,{waitUntil:'domcontentloaded'});
        await this.page.evaluate(name=>{window.name=name;},label);
        await this.page.locator('[data-e2e="im-entry"]').waitFor({state:'visible',timeout:15_000});
      }else await this.navigate(RECOMMEND, signal);
    }
    return this.page;
  }
  async navigate(url, signal) {
    aborted(signal);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.evaluate(name => { window.name = name; }, `deepseek-douyin-${this.source}`);
    if (url === RECOMMEND && this.page.url().includes('/jingxuan')) {
      await this.page.locator('a').filter({hasText:/^推荐$/}).click();
    }
    const targetId=/\/video\/(\d+)/.exec(url)?.[1];
    await this.settle(signal, {kind:targetId?'video':url.includes('/search/')?'search':'recommend',videoId:targetId});
  }
  async settle(signal, {kind='recommend',videoId}={}) {
    for (let i=0;i<16;i++) {
      aborted(signal);
      const state = await this.page.evaluate(readPageState);
      if(state.loginRequired||state.verificationRequired) return state;
      const detail=/\/video\/\d+/.test(state.url??'')||/[?&]modal_id=\d+/.test(state.url??'');
      if(kind==='search' && state.searchResults.length && !detail) return state;
      if(kind==='search' && /暂无搜索结果|没有找到相关|暂无结果/.test(state.visibleText)) return state;
      if(kind==='video' && detail && state.video?.id===videoId && state.video.readyState>=2) return state;
      if(kind==='recommend' && state.video?.id && state.video.readyState>=2) return state;
      await wait(500, signal);
    }
    throw new Error(kind==='search'?'搜索结果未就绪，未确认搜索完成。':kind==='video'?'目标作品尚未加载完成，请读取状态后重试。':'推荐流尚未读到就绪视频。');
  }
  async state({ record = true } = {}) {
    const state = await this.page.evaluate(readPageState);
    if (record && state.video?.id) {
      try { this.store().recordVideo(state, this.source); } catch { state.memoryWarning = '视频状态已读取，记忆记录暂不可用。'; }
    }
    return state;
  }
  // ===== 2026-10-29：抽帧故事板 =====
  // 每条视频开始看的时候在页面里起一个 2fps 的抽帧循环（原尺寸 JPEG 存在页面内存），
  // 看完再在页面里挑格、拼成最多 3 张故事板回传；几百帧不经过 CDP。
  async startFrameGrab(videoId, { intervalMs = GRAB_DEFAULTS.intervalMs } = {}) {
    return await this.withPage(async (page) => {
      await page.evaluate(installFrameGrabber);
      return await page.evaluate((options) => (window.__dshGrab ? window.__dshGrab.start(options) : { started: false }), { videoId: String(videoId), intervalMs });
    });
  }
  async stopFrameGrab() {
    return await this.withPage(async (page) => page.evaluate(() => (window.__dshGrab ? window.__dshGrab.stop() : { frames: 0, videoId: null })));
  }
  async frameGrabMeta() {
    return await this.withPage(async (page) => page.evaluate(() => (window.__dshGrab ? window.__dshGrab.meta() : null)));
  }
  // 挑格 + 拼故事板 + 落盘。返回 [{ mimeType, data, times, width, height, file }]，最多 3 张。
  async composeStoryboard(videoId, { duration = null, maxSheets = GRAB_DEFAULTS.maxSheets, signal } = {}) {
    const id = String(videoId || '');
    if (!/^\d{6,40}$/.test(id)) return { sheets: [], cells: 0, frames: 0 };
    return await this.withPage(async (page) => {
      const meta = await page.evaluate(() => (window.__dshGrab ? window.__dshGrab.meta() : null));
      // 只保留第一遍：万一混进了重播后的帧，宁可少几格，也不要两条时间线。
      const times = trimToFirstPass(Array.isArray(meta?.times) ? meta.times : []);
      const scores = (Array.isArray(meta?.scores) ? meta.scores : []).slice(0, times.length);
      const lums = (Array.isArray(meta?.lums) ? meta.lums : []).slice(0, times.length);
      if (times.length < 2) return { sheets: [], cells: 0, frames: times.length, meta };
      // 视频播完了：先停掉抽帧，帧集合稳定下来再挑。
      await page.evaluate(() => (window.__dshGrab ? window.__dshGrab.stop() : null));
      const length = Number.isFinite(duration) && duration > 0 ? duration : times[times.length - 1];
      const cells = planCells(length, { minCells: GRAB_DEFAULTS.minCells, maxCells: GRAB_DEFAULTS.maxCells, maxSheets, secondsPerCell: GRAB_DEFAULTS.secondsPerCell });
      const indices = chooseIndices({ times, scores, lums, cells });
      // 2026-10-29 主人定：上限仍是 3 张，但每张装满 16 格，最后一张不足 6 格就不拼。
      const sizes = planSheets(indices.length, { maxSheets, maxCells: GRAB_DEFAULTS.maxCells, minTail: GRAB_DEFAULTS.minTailCells });
      const groups = [];
      let cursor = 0;
      for (const size of sizes) { groups.push(indices.slice(cursor, cursor + size)); cursor += size; }
      const output = await page.evaluate(composeStoryboardSheets, { groups, cellWidth: GRAB_DEFAULTS.cellWidth, labelHeight: GRAB_DEFAULTS.labelHeight, quality: GRAB_DEFAULTS.quality });
      const sheets = [];
      const dir = path.join(this.limits().stateDir, 'sheets');
      try { mkdirSync(dir, { recursive: true }); } catch { /* 写不进图不影响评论 */ }
      for (const [index, sheet] of (Array.isArray(output) ? output : []).entries()) {
        const match = /^data:(image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(sheet?.dataUrl || ''));
        if (!match) continue;
        const bytes = Buffer.byteLength(match[2], 'base64');
        let file = null;
        try {
          file = path.join(dir, id + '-sheet-' + (index + 1) + '.jpg');
          writeFileSync(file, Buffer.from(match[2], 'base64'));
          appendFileSync(path.join(this.limits().stateDir, 'sheets.jsonl'), JSON.stringify({ at: new Date().toISOString(), videoId: id, sheet: index + 1, cells: sheet.times.length, times: sheet.times, width: sheet.width, height: sheet.height, bytes, file: 'sheets/' + path.basename(file) }) + '\n');
        } catch { file = null; }
        sheets.push({ mimeType: match[1], data: match[2], times: sheet.times, width: sheet.width, height: sheet.height, bytes, file });
      }
      const used = groups.reduce((sum, group) => sum + group.length, 0);
      return { sheets, cells: used, frames: times.length, dropped: indices.length - used, times: indices.slice(0, used).map((index) => times[index]) };
    }, { signal });
  }
  // 2026-10-29 主人定：开头采样也抽帧——5 秒、每秒一张、拼成一张 5 格图，用来看不看这条。
  // 只从页面里已有的抽帧里挑（不额外截图），挑靠近 0/1/2/3/4 秒的五张；不够就退回 null，
  // 调用方会退回原来「观察截图拼图」那条路。
  async grabSampleSheet(videoId, { count = 5, seconds = 5, columns = 3, cellWidth = 480, labelHeight = 24, signal } = {}) {
    const id = String(videoId || '');
    if (!/^\d{6,40}$/.test(id)) return null;
    return await this.withPage(async (page) => {
      const span = Number(seconds) > 0 ? Number(seconds) : 5;
      const want = Math.max(2, Math.min(8, count));
      // 新视频首帧常在 2 秒后才抓到；等一小会儿，让采样真的凑够 5 个时间点（最多 2.5 秒）。
      const deadline = Date.now() + 2500;
      let meta = await page.evaluate(() => (window.__dshGrab ? window.__dshGrab.meta() : null));
      while ((meta?.times?.length || 0) < want && Date.now() < deadline) {
        await delay(300);
        meta = await page.evaluate(() => (window.__dshGrab ? window.__dshGrab.meta() : null));
      }
      const times = Array.isArray(meta?.times) ? meta.times : [];
      if (times.length < 2) return null;
      const picked = sampleIndices(times, { count: want, seconds: span });
      if (picked.length < 2) return null;
      const output = await page.evaluate(composeStoryboardSheets, { groups: [picked], columns, cellWidth, labelHeight, quality: GRAB_DEFAULTS.quality });
      const sheet = Array.isArray(output) ? output[0] : null;
      const match = /^data:(image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(sheet?.dataUrl || ''));
      if (!match) return null;
      const bytes = Buffer.byteLength(match[2], 'base64');
      let file = null;
      try {
        const dir = path.join(this.limits().stateDir, 'sheets');
        mkdirSync(dir, { recursive: true });
        file = path.join(dir, id + '-sample.jpg');
        writeFileSync(file, Buffer.from(match[2], 'base64'));
      } catch { file = null; }
      return { mimeType: match[1], data: match[2], width: sheet.width, height: sheet.height, times: sheet.times, bytes, file };
    }, { signal });
  }
  // 2026-10-29：弹幕走接口。页面里的弹幕是画在 canvas 上的，DOM 读不到字；
  // /aweme/v1/web/danmaku/get_v2/ 是明文 JSON（text / offset_time / digg_count），挂一次 response 钩子就能拿到。
  attachDanmakuHook(page) {
    try {
      if (!page || page.__dshDanmakuHooked) return;
      page.__dshDanmakuHooked = true;
      page.on('response', (response) => {
        try {
          const url = response.url();
          if (!url.includes('/danmaku/get_v2')) return;
          const template = danmakuUrlTemplate(url);
          if (template) this.danmakuUrlTemplate = template;
          response.json().then((body) => {
            const list = Array.isArray(body?.danmaku_list) ? body.danmaku_list : [];
            if (!list.length) return;
            let videoId = '';
            try { const parsed = new URL(url); videoId = parsed.searchParams.get('item_id') || parsed.searchParams.get('aweme_id') || ''; } catch { /* 用下面 body 里的 */ }
            if (!/^\d{6,40}$/.test(videoId)) videoId = String(list[0]?.item_id || '');
            if (/^\d{6,40}$/.test(videoId)) this.storeDanmaku(videoId, list);
          }).catch(() => {});
        } catch { /* 单条响应解析失败不影响页面 */ }
      });
    } catch { /* 钩子挂不上不影响观看 */ }
  }
  storeDanmaku(videoId, list) {
    try {
      this._danmaku ||= new Map();
      this._danmaku.set(videoId, list);
      const dir = path.join(this.limits().stateDir, 'danmaku');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, videoId + '.json'), JSON.stringify({ videoId, at: new Date().toISOString(), count: list.length, list }));
    } catch { /* 落盘失败不影响观看 */ }
  }
  // 取这条作品的高赞弹幕：内存 → 磁盘 → 用抓到的接口模板重放一次。拿不到就返回空，评论照常写。
  // maxTime：只要前 N 秒里的弹幕（采样决策用——整条 top-20 会把结尾的高赞当成开头的证据）。
  async danmakuFor(videoId, { limit = 20, duration = null, maxTime = null } = {}) {
    const id = String(videoId || '');
    if (!/^\d{6,40}$/.test(id)) return { picks: [], total: 0, source: 'none', text: '' };
    let list = this._danmaku?.get(id) || null;
    let source = list ? 'cached' : 'none';
    if (!list) {
      try { list = JSON.parse(readFileSync(path.join(this.limits().stateDir, 'danmaku', id + '.json'), 'utf8'))?.list ?? null; source = list ? 'disk' : 'none'; } catch { list = null; }
    }
    if (!list?.length && this.danmakuUrlTemplate && this.page && !this.page.isClosed()) {
      const url = danmakuUrlFor(this.danmakuUrlTemplate, id);
      if (url) {
        try {
          const body = await this.page.evaluate(async (target) => { const answer = await fetch(target, { credentials: 'include' }); return await answer.json(); }, url);
          list = Array.isArray(body?.danmaku_list) ? body.danmaku_list : null;
          if (list?.length) { this.storeDanmaku(id, list); source = 'fetched'; }
        } catch { /* 接口变了或没登录：这次就不带弹幕 */ }
      }
    }
    // 时间口径：接口的 offset_time 有秒/毫秒两种，先统一换算，再按 maxTime 截取。
    const scoped = danmakuWithin(list || [], maxTime, duration);
    let picks = pickTopDanmaku(scoped, { limit, duration });
    // 2026-10-29 首轮实测：有的作品弹幕全是 0 赞，按赞数筛完就没东西可给了。
    // 这种情况退一步取前 5 条——弹幕仍是"观众在反应"的证据，只是没有热度。
    if (!picks.length && scoped.length) picks = pickTopDanmaku(scoped, { limit: Math.min(5, limit), duration, minLikes: 0 });
    return { picks, total: (list || []).length, scoped: scoped.length, source: picks.length ? source : 'empty', text: formatDanmaku(picks) };
  }
  withPage(callback,{signal}={}) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      const release=await lock(`tab-${this.source}`,signal);
      const onAbort=()=>{this.browser?.close().catch(()=>{});};
      signal?.addEventListener('abort',onAbort,{once:true});
      try {
        aborted(signal);
        const page=await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) await (await this.getWatchMode()).apply(page);
        if(new URL(page.url()).origin!=='https://www.douyin.com') throw new Error('专用标签页已离开抖音，请重新打开抖音后操作。');
        return await withDeadline(callback(page, signal), PAGE_DEADLINE_MS, `浏览器操作（${this.source}）`);
      }finally{signal?.removeEventListener('abort',onAbort);release();}
    });
    this.queue=operation;return operation;
  }
  execute(name, args = {}, { signal, humanAuthorized = false, autonomousRunId } = {}) {
    const definition = TOOL_DEFINITIONS.find(tool=>tool.name===name);
    if (!definition) return Promise.reject(new Error('不支持的抖音工具。'));
    try { validateToolArguments(definition,args); } catch(error) { return Promise.reject(error); }
    const operation = this.queue.catch(()=>{}).then(async()=>{
      let releaseNativeLease;
      try {
      aborted(signal);
      if(this.source==='dsh'&&!autonomousRunId&&VIDEO_ACTIONS.has(name)) releaseNativeLease=await acquireNativeVideoLease(this.limits().stateDir,signal);
      if (this.limitsEnabled && ['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_play','douyin_listen','douyin_pause'].includes(name)) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(this.limits().stateDir,'watch-loop.lock'),'utf8')); }
        catch(error) { if(error.code!=='ENOENT' && name!=='douyin_pause') throw new Error('自主观看锁无法核对，未操作视频。'); }
        if(owner) {
          let living=false;
          if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.runId!=='string') { if(name!=='douyin_pause')throw new Error('自主观看锁无效，未操作视频。'); }
          else { try {process.kill(owner.pid,0);living=true;}catch(error){living=error.code==='EPERM';} }
          if(living && owner.runId!==autonomousRunId) {
            if(name!=='douyin_pause') throw Object.assign(new Error('自主观看正在运行，请先停止它再手动操作视频。'),{status:409});
            const requestFile=path.join(this.limits().stateDir,'watch-stop.request.json'),temporary=`${requestFile}.${randomUUID()}.tmp`;
            try {writeFileSync(temporary,JSON.stringify({runId:owner.runId,requestedAt:Date.now()}),{flag:'wx'});renameSync(temporary,requestFile);}
            finally {try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
          }
        }
      }
      if(name.startsWith('douyin_chat_')) {
        // 整段外面再套一层超时：getChatService 的模块加载、以及 chat.* 里不带 signal 的等待也一并兜住。
        return await withDeadline((async()=>{
          const chat=await this.getChatService();aborted(signal);
          if(name==='douyin_chat_contacts') return chat.listContacts({signal});
          if(name==='douyin_chat_status') return chat.state();
          if(name==='douyin_chat_start') return chat.start({signal});
          if(name==='douyin_chat_stop') return chat.stop();
          if(name==='douyin_chat_read') return chat.readConversation(args.recipientId,{signal});
          if(name==='douyin_chat_observe') return chat.observeMessage(args.recipientId,args.messageId,{signal});
          throw new Error('不支持的私信工具。');
        })(), SERVICE_DEADLINE_MS, `私信工具 ${name}`);
      }
      if (name.startsWith('douyin_spark_')) {
        return await withDeadline((async()=>{
          const spark = await this.getSparkService(); aborted(signal);
          if (name === 'douyin_spark_status') return spark.state();
          if (name === 'douyin_spark_start') return spark.start({ schedule: true, explicit: true, signal });
          if (name === 'douyin_spark_stop') return spark.stop({ explicit: true });
          throw new Error('不支持的续火花工具。');
        })(), SERVICE_DEADLINE_MS, `续火花工具 ${name}`);
      }
      if (name === 'douyin_report_status') return (await this.getReport()).state();
      if (name === 'douyin_report_generate') return (await this.getReport()).generate({ reason: 'manual' });
      if(name==='douyin_media_status') return (await this.getMediaAdapter()).status();
      if(name==='douyin_forward_video') {
        if(humanAuthorized!==true) return {sent:false,requiresUserAction:true,note:'请在本机控制台选择这位好友并点击转发；此工具不会代替人类按钮授权。',recipientId:args.recipientId,url:args.url??null};
        return (await this.getForwarder()).forward(args,{signal,humanAuthorized:true});
      }
      if (name==='douyin_recall') return this.store().recall({query:args.query??'',limit:args.limit??10});
      if (name==='douyin_persona_status') return this.getPersonaMemory().snapshot();
      if (name==='douyin_watch_status') {
        const {AutonomousWatch}=await import('./autonomous-watch.mjs?v=10');
        this.watchStatusReader??=new AutonomousWatch({controller:this,config:{},videoLimits:this.limits(),personaMemory:this.getPersonaMemory(),source:this.source==='dsh'?'dsh':'api',stateDir:this.limits().stateDir});
        return this.watchStatusReader.state();
      }
      if (name==='douyin_interest_record') return this.getPersonaMemory().updateAgentInterests({ evidenceId:args.evidenceId,topics:[{topic:args.topic,signal:args.signal}],reflection:args.reflection },{source:this.source==='dsh'?'dsh':'api'});
      if (name==='douyin_remember') {
        const state = this.page && !this.page.isClosed() ? await this.state({record:false}) : null;
        return this.store().remember({content:args.content,kind:args.kind??'note',source:this.source,
          videoId:state?.video?.id,url:state?.video?.url,author:state?.video?.author,title:state?.video?.title});
      }
      if(name==='douyin_video_limits_status') return this.limits().state();
      this.watchVideoLimits();
      await this.checkVideoLimits(name);
      const release = await lock(`tab-${this.source}`,signal);
      let onAbort;
      try {
        onAbort = () => { this.browser?.close().catch(()=>{}); };
        signal?.addEventListener('abort',onAbort,{once:true});
        await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) {
          const mode = await this.getWatchMode();
          await mode.apply(this.page);
          if (autonomousRunId && mode.state().silent) {
            try { await mode.minimizeManagedWindow(this.page); } catch { /* 未核实窗口归属时继续保持静音，不隐藏其他页面。 */ }
          }
        }
        await this.checkVideoLimits(name);
        if(this.limitsEnabled && !this.limits().state().allowed) await this.pauseForLimits();
        if(!['douyin_open','douyin_search','douyin_open_video'].includes(name) && new URL(this.page.url()).origin!=='https://www.douyin.com') {
          return this.page.evaluate(readPageState);
        }
        if (name==='douyin_open') await this.navigate(RECOMMEND,signal);
        if (name==='douyin_search') await this.navigate(`https://www.douyin.com/search/${encodeURIComponent(args.query)}`,signal);
        if (name==='douyin_open_video') {
          if (args.url) await this.navigate(`https://www.douyin.com/video/${/\/video\/(\d+)/.exec(args.url)[1]}`,signal);
          else {
            const before = await this.state();
            const result = before.searchResults.find(item=>item.index===args.index);
            if (!result) throw new Error('这个 index 不在当前可见搜索结果内，请重新搜索。');
            const card = result.id ? this.page.locator(`[id="waterfall_item_${result.id}"] .search-result-card`) : this.page.locator('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]').filter({visible:true}).nth(args.index);
            if(await card.count()) { await card.click(); await this.settle(signal,{kind:'video',videoId:result.id}); }
            else if(result.url) await this.navigate(result.url,signal);
            else throw new Error('搜索结果卡片已变化，请重新搜索。');
          }
        }
        if (name==='douyin_next'||name==='douyin_previous') return await this.switchVideo(name==='douyin_next'?1:-1,signal,{recordLearning:!autonomousRunId});
        if (name==='douyin_play'||name==='douyin_pause') {
          // 2026-10-23：平台播完换播放器实例时，页面里的 video.play() 返回的 promise 可能永远不 settle，
          // 外面 await 就整轮卡死（实测 16:52 那次，页面在播、宿主却停在 await 上）。最多等 800ms，不等它。
          await (await this.currentVideo()).evaluate(async (video, play) => {
            try { if (play) await Promise.race([video.play(), new Promise(resolve => setTimeout(resolve, 800))]); else video.pause(); } catch { /* 播不动就交给后面的状态核对 */ }
          }, name==='douyin_play');
          if (name==='douyin_play') await wait(600,signal);
        }
        if (name==='douyin_observe'||name==='douyin_screenshot') return await this.capture(name==='douyin_observe'?args.seconds??3:0,signal,{recordLearning:!autonomousRunId,frameCount:name==='douyin_observe'?args.frames??null:null});
        // local add: 连看期间补帧用。只取画面，不注册人格证据——否则同一部作品会被记成很多条观察。
        if (name==='douyin_grab_frame') return await this.capture(0,signal,{recordLearning:false,recordEvidence:false});
        if(name==='douyin_listen') return await this.listen(args.seconds??8,signal);
        aborted(signal);
        return this.state();
      } finally { signal?.removeEventListener('abort',onAbort); release(); }
      } finally { await releaseNativeLease?.(); }
    });
    this.queue=operation; return operation;
  }
  async currentVideo() {
    // local fix: 抖音页面上有多个 <video>（预加载克隆面积和主播位一样大）。只按面积排会选到
    // 暂停的克隆——录音拿不到音轨、play/pause 也打偏。正在播放的优先，其次才比面积。
    const index = await this.page.locator('video').evaluateAll(videos=>videos.map((video,index)=>{
      const r=video.getBoundingClientRect();
      const playing=!video.paused&&video.readyState>0;
      return {index,playing:playing?1:0,area:Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))};
    }).filter(item=>item.area>0).sort((a,b)=>(b.playing-a.playing)||(b.area-a.area))[0]?.index);
    if(index===undefined) throw new Error('没有在视口内找到视频。');
    return this.page.locator('video').nth(index);
  }
  async switchVideo(direction,signal,{recordLearning=true}={}) {
    const before = await this.state();
    if (!before.video) throw new Error('当前没有可见视频，请先打开推荐或搜索作品。');
    if(before.loginRequired) throw new Error('抖音要求登录，请在专用浏览器窗口扫码登录后再继续。');
    if(before.verificationRequired) throw new Error('抖音弹出安全验证（验证码/滑块），请在专用浏览器窗口手动通过后再继续。');
    let skipEvidenceId=null;
    if(recordLearning && direction>0 && this.lastObservationVideoId===before.video.id && this.lastObservationEvidenceId && this.lastObservationState?.video?.id===before.video.id) {
      const wallSeconds=(Date.now()-this.lastObservationAt)/1000;
      if(Number.isFinite(wallSeconds) && wallSeconds>0 && wallSeconds<=30) {
        try {
          const viewing=this.getPersonaMemory().recordViewing?.({evidenceId:this.lastObservationEvidenceId,from:this.lastObservationState,to:before,wallSeconds,sampleId:randomUUID()},{source:this.source});
          if(viewing?.accepted===true) skipEvidenceId=this.lastObservationEvidenceId;
        }catch{/* 不能核实等待期间的进度时不补记快划偏好，换片仍按原操作执行。 */}
      }
    }
    const arrow=this.page.locator(`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`).filter({visible:true});
    // local fix: 右侧推荐面板（#slidelist）展开时会把切换箭头盖住，click 一直重试到超时，
    // 整轮被判 failed（实测 2026-10-22 17:45）。点不动就退回滚轮，别让浮层决定这一轮的生死。
    let clicked=false;
    if(await arrow.count()) {
      try { await arrow.first().click({ timeout: 5000 }); clicked=true; } catch { clicked=false; }
    }
    if(!clicked) {
      const box=before.video.viewport;
      await this.page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      await this.page.mouse.wheel(0,direction*700);
    }
    let after;
    for(let i=0;i<12;i++) {
      await wait(300,signal); after=await this.state();
      if(after.video?.id&&before.video.id&&after.video.id!==before.video.id&&after.video.readyState>=2) break;
    }
    if(skipEvidenceId && after.video?.id && after.video.id!==before.video.id && after.video.readyState>=2) {
      try {this.getPersonaMemory().recordBehavior?.({evidenceId:skipEvidenceId,action:'skip',sampleId:randomUUID(),confirmed:true},{source:this.source});}catch{/* 学习失败不改变已确认的切片结果。 */}
    }
    return {changed:before.video.id&&after.video?.id?before.video.id!==after.video.id:null,
      before:before.video,after:after.video,state:after};
  }
  // local fix: 提窗原来 spawn 的是 PowerShell（detached + stdio ignore）。实测这种组合下
  // powershell.exe 会直接退出、连 raise.log 都不写（13:52 之后再没有记录），人看到的视频
  // 一直被别的窗口压着。改成编译好的小 exe（约 28 ms，不启动 PowerShell、不编译 C#）；
  // 带 1.5 秒空闲保护，用户正在敲键盘/点鼠标时不抢前台。没有 exe 时退回 PowerShell。
  raiseWindow() {
    try {
      const exe=process.env.DOUYIN_RAISE_EXE||'D:\\Deep\\tools\\raise-douyin.exe';
      if(existsSync(exe)) { const child=spawn(exe,['抖音','1500'],{windowsHide:true,stdio:'ignore'}); child.on('error',()=>{}); child.unref(); return true; }
      const helper=process.env.DOUYIN_RAISE_SCRIPT||'D:\\Deep\\tools\\raise-douyin.ps1';
      const psExe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const child=spawn(psExe,['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',helper],{windowsHide:true,stdio:'ignore'});
      child.on('error',()=>{}); child.unref(); return true;
    } catch { return false; }
  }
  async capture(seconds,signal,{recordLearning=true,recordEvidence=true,frameCount=null}={}) {
    const captureStarted=Date.now();
    // 2026-10-24：查"每秒闪白"用——每次截图记一行，谁、什么时候、第几张。
    try { appendFileSync(path.join(this.limits().stateDir,'capture.log'), `${new Date().toISOString()} sec=${seconds} rec=${recordLearning?1:0} ev=${recordEvidence?1:0}\n`); } catch { /* 记不上就算了 */ }
    // local fix: 窗口可能被别的程序挡住。截图走 CDP 渲染层，挡住了也能拿到完整画面，
    // 但人看不到她在看什么。观察前确认一次前台，不在就用 OS 级助手顶上来
    // （CDP 的 bringToFront 会被 Windows 前台锁拦掉，实测无效），15 秒最多一次。
    try {
      const focusAt=Date.now();
      if(focusAt-(this._lastFocusRaise||0)>=15_000) {
        // 不再问 document.hasFocus()：实测它在这个 Playwright 页面里恒为 true，条件永远进不去。
        this._lastFocusRaise=focusAt;
        if(!this.raiseWindow()) await this.page.bringToFront().catch(()=>{});
      }
    } catch { /* 提窗失败不影响观察 */ }
    let state=await this.state();
    if(state.loginRequired||state.verificationRequired||state.privateChatVisible) return {state,frames:[],note:'登录、验证或私信面板遮挡画面，本次没有采集图片。'};
    if(!state.video) return {state,frames:[],note:'没有可见视频画面，请先打开作品。'};
    const frames=[],samples=Number.isSafeInteger(frameCount)&&frameCount>1?Math.min(frameCount,8):(seconds?3:1);
    const before={...state.video}, firstState=structuredClone(state);
    let sampledState=state,sampledAt=captureStarted,stoppedReason=null;
    for(let index=0;index<samples;index++) {
      aborted(signal);
      if(index) await wait(seconds*1000/(samples-1),signal);
      state=await this.state();
      await this.checkVideoLimits('douyin_observe');
      if(state.loginRequired||state.verificationRequired||state.unsupportedPage||state.privateChatVisible) return {state,frames:[],note:'出现登录、验证、私信面板或离开抖音，已丢弃本次画面。'};
      if(state.video?.id!==before.id) {stoppedReason='采样期间切换作品，保留的画面只属于此前作品。';break;}
      const {x,y,width,height}=state.video.viewport;
      if(width<2||height<2) break;
      // 采样保留动画和光标，避免截图期间改写播放器页面的样式。
      const data=await this.page.screenshot({type:'jpeg',quality:65,clip:{x,y,width,height},animations:'allow',caret:'initial',timeout:10_000});
      try { appendFileSync(path.join(this.limits().stateDir,'capture.log'), `${new Date().toISOString()}   shot i=${index} v=${state.video?.id} t=${state.video?.time}\n`); } catch { /* 记不上就算了 */ }
      aborted(signal);
      const checked=await this.state();
      if(checked.loginRequired||checked.verificationRequired||checked.unsupportedPage||checked.privateChatVisible) return {state:checked,frames:[],note:'截图期间出现登录、验证、私信面板或离开抖音，已丢弃本次画面。'};
      if(checked.video?.id!==before.id) {stoppedReason='截图期间切换作品，本帧已丢弃。';break;}
      frames.push({mimeType:'image/jpeg',data:data.toString('base64'),time:state.video.time,videoId:state.video.id});
      sampledState=checked;sampledAt=Date.now();
    }
    const result={state:sampledState,frames,observation:{seconds,videoId:before.id,stoppedReason,beforeTime:before.time,beforePaused:before.paused,afterTime:sampledState.video?.time,paused:sampledState.video?.paused,
      note:'采集的是实际视频视口画面；没有音频，只能说明这些采样时刻。'}};
    if (frames.length && recordEvidence && ['api','dsh'].includes(this.source)) {
      try {
        const persona=this.getPersonaMemory(),origin={source:this.source};
        result.personaEvidenceId=persona.recordObservation(result,{...origin,kind:'visual'}).evidenceId;
        const wallSeconds=(sampledAt-captureStarted)/1000,sampleId=randomUUID();
        if(persona.recordViewing && wallSeconds<=30) {
          result.viewing={evidenceId:result.personaEvidenceId,sampleId,...persona.recordViewing({evidenceId:result.personaEvidenceId,from:firstState,to:sampledState,wallSeconds,sampleId},origin)};
          if(recordLearning && this.lastObservationVideoId===before.id && result.viewing.creditedSeconds>0) persona.recordBehavior?.({evidenceId:result.personaEvidenceId,action:'stay',sampleId,confirmed:true},origin);
        }
        this.lastObservationVideoId=before.id;this.lastObservationEvidenceId=result.personaEvidenceId;
        this.lastObservationState=structuredClone(sampledState);this.lastObservationAt=sampledAt;
      }
      catch { result.personaWarning='本次画面未登记为兴趣证据，不能据此更新人格兴趣。'; }
    }
    return result;
  }
  // 2026-10-27：把同一条作品的多个时刻拼成一张图（浏览器画布，不装原生图片库）。
  // 只做本地合成，不改页面、不额外截图、不花模型请求；失败由调用方退回原来的首尾两帧。
  async composeFrames(frames, { columns = COMPOSITE_DEFAULTS.columns, cellHeight = COMPOSITE_DEFAULTS.cellHeight, cropRight = COMPOSITE_DEFAULTS.cropRight, cropBottom = COMPOSITE_DEFAULTS.cropBottom, cropRightPx = COMPOSITE_DEFAULTS.cropRightPx, cropBottomPx = COMPOSITE_DEFAULTS.cropBottomPx, signal } = {}) {
    const prepared = prepareCompositeFrames(frames);
    return await this.withPage(async (page) => {
      const output = await page.evaluate(composeFramesInPage, { frames: prepared, columns, cellHeight, cropRight, cropBottom, cropRightPx, cropBottomPx });
      const match = /^data:(image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(output?.dataUrl || ''));
      if (!match) throw new Error('拼图没有生成有效的 JPEG。');
      const bytes = Buffer.byteLength(match[2], 'base64');
      if (bytes > 2_000_000) throw new Error('拼图 JPEG 超过大小限制。');
      // 2026-10-28 主人要看「看完一条视频的完整过程」：每张拼图都落盘，文件名带每格的视频秒数，
      // 另追加一行索引（视频 id、格子时间、尺寸、字节）。写不进去不影响观看。
      try {
        const dir = path.join(this.limits().stateDir, 'composites');
        mkdirSync(dir, { recursive: true });
        const cellTimes = prepared.map((frame) => (Number.isFinite(frame.time) ? frame.time.toFixed(1) : 'x'));
        const videoId = prepared[0]?.videoId || 'unknown';
        const name = videoId + '-' + cellTimes.join('_') + '-' + Date.now() + '.jpg';
        writeFileSync(path.join(dir, name), Buffer.from(match[2], 'base64'));
        appendFileSync(path.join(this.limits().stateDir, 'composites.jsonl'), JSON.stringify({ at: new Date().toISOString(), videoId, cells: prepared.length, times: cellTimes.map(Number), width: output.width, height: output.height, bytes, file: 'composites/' + name }) + '\n');
      } catch { /* 落盘失败不影响观看 */ }
      return { mimeType: match[1], data: match[2], width: output.width, height: output.height, cellWidth: output.cellWidth, cellHeight: output.cellHeight, crop: output.crop, bytes, frames: prepared.map((frame) => ({ time: frame.time, videoId: frame.videoId })) };
    }, { signal });
  }
  async captureAudio(seconds,signal) {
    await this.checkVideoLimits('douyin_listen');
    const before=await this.state({record:false});
    if(before.loginRequired||before.verificationRequired||before.privateChatVisible||!before.video?.id) throw new Error('当前没有可录取的公开作品，或登录、验证、私信面板遮挡页面。');
    const result=await (await this.currentVideo()).evaluate(async(video,seconds)=>{
      if(typeof video.captureStream!=='function' || typeof MediaRecorder==='undefined') throw new Error('浏览器没有提供当前视频的可用音轨采集接口。');
      const wasPaused=video.paused; await video.play();
      const stream=video.captureStream();
      const tracks=stream.getAudioTracks().map(track=>track.clone());
      if(!tracks.length) {if(wasPaused)video.pause();throw new Error('当前作品没有向浏览器暴露可采集音轨，未录取其他声音。');}
      const audio=new MediaStream(tracks),chunks=[];
      const mimeType=['audio/webm;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType) {tracks.forEach(track=>track.stop());if(wasPaused)video.pause();throw new Error('浏览器不支持音轨录取格式。');}
      // 2026-10-25 20:40：转写为空≠没声音（主人分享的短片常只有呼吸声、语气词）。
      // 顺手测一个响度，好让模型知道「有音轨、多响」，别把「没有人声」说成「没录到声音」。
      // best-effort：AudioContext 建不起来就跳过，不影响录音本身。
      let meter=null;
      try {
        const Ctx=window.AudioContext||window.webkitAudioContext;
        if(Ctx){
          const context=new Ctx(),analyser=context.createAnalyser();analyser.fftSize=2048;
          context.createMediaStreamSource(audio).connect(analyser);
          const buffer=new Float32Array(analyser.fftSize),levels=[];
          const id=setInterval(()=>{analyser.getFloatTimeDomainData(buffer);let sum=0;for(const value of buffer)sum+=value*value;levels.push(Math.sqrt(sum/buffer.length));},100);
          meter={context,id,levels};
        }
      } catch { meter=null; }
      try {
        const recorder=new MediaRecorder(audio,{mimeType,audioBitsPerSecond:64000});
        await new Promise((resolve,reject)=>{
          let size=0; const timer=setTimeout(()=>recorder.state!=='inactive'&&recorder.stop(),seconds*1000);
          recorder.ondataavailable=event=>{size+=event.data.size;if(size>2_000_000){clearTimeout(timer);recorder.stop();reject(new Error('音轨超过2MB采集预算。'));}else chunks.push(event.data);};
          recorder.onerror=()=>{clearTimeout(timer);reject(new Error('当前视频音轨采集失败。'));};
          recorder.onstop=()=>{clearTimeout(timer);resolve();};recorder.start(250);
        });
        const bytes=new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer());
        if(!bytes.length) throw new Error('当前音轨没有生成可用数据。');
        let encoded='';for(let offset=0;offset<bytes.length;offset+=32768) encoded+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
        let loudness=null;
        if(meter){try{
          clearInterval(meter.id);
          const levels=meter.levels.filter(value=>Number.isFinite(value));
          if(levels.length){const rms=levels.reduce((sum,value)=>sum+value,0)/levels.length;loudness={samples:levels.length,rms:Number(rms.toFixed(5)),peak:Number(Math.max(...levels).toFixed(5))};}
        }catch{/* 测不出响度不影响录音 */}}
        return {data:btoa(encoded),mimeType,bytes:bytes.length,loudness};
      }finally{tracks.forEach(track=>track.stop());if(wasPaused)video.pause();if(meter){clearInterval(meter.id);meter.context.close?.().catch(()=>{});}}
    },seconds);
    aborted(signal);await this.checkVideoLimits('douyin_listen');
    const after=await this.state({record:false});
    if(after.loginRequired||after.verificationRequired||after.privateChatVisible||after.unsupportedPage||after.video?.id!==before.video.id) throw new Error('录音期间页面或作品身份改变，音轨已丢弃。');
    return {...result,videoId:before.video.id,beforeTime:before.video.time,afterTime:after.video.time,seconds,state:after};
  }
  async listen(seconds,signal) {
    const media=await this.getMediaAdapter(),settings=await media.settings();
    if(!settings.enabled) return {ok:true,audioAvailable:false,note:'音频能力默认关闭，请由用户在本机控制台选择开启。'};
    const captured=await this.captureAudio(seconds,signal);
    const directory=resolveRuntimePaths().mediaCaptureDir;mkdirSync(directory,{recursive:true});
    const target=path.join(directory,`${randomUUID()}.webm`);writeFileSync(target,Buffer.from(captured.data,'base64'));
    try {
      const result=await media.transcribeAudio({source:target,backend:settings.backend,durationSeconds:seconds},{signal});
      return {ok:true,audioAvailable:result.ok===true,state:captured.state,audio:{...result,videoId:captured.videoId,beforeTime:captured.beforeTime,afterTime:captured.afterTime,seconds,bytes:captured.bytes,hasAudio:captured.bytes>0,loudness:captured.loudness??null},note:'只采集当前视频这一小段实际音轨；转写不能代替音乐或环境声理解。'};
    }finally{try{unlinkSync(target);}catch{}}
  }
  async close() {
    this.cancelLimitsWatch?.(); this.cancelLimitsWatch=null;
    if(this.limitsEnabled) await this.pauseForLimits();
    await this.queue.catch(()=>{});
    await this.browser?.close().catch(()=>{});
    if(this.sparkPromise) await this.sparkPromise.then(spark=>spark.close()).catch(()=>{});
    if(this.commentsPromise) await this.commentsPromise.then(comments=>comments.close()).catch(()=>{});
    if(this.commenterPromise) await this.commenterPromise.then(commenter=>commenter.close?.()).catch(()=>{});
    if(this.chatPromise) await this.chatPromise.then(chat=>chat.close()).catch(()=>{});
    if(this.forwarderPromise) await this.forwarderPromise.then(forwarder=>forwarder.close?.()).catch(()=>{});
    this.memory?.close(); this.browser=null; this.page=null; this.memory=null;
  }
}
