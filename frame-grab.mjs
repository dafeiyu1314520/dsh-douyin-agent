// frame-grab.mjs —— 把 <video> 的画面按 2fps 抽成原尺寸 JPEG，攒成故事板。
// 2026-10-29 主人定：抽帧用 canvas 抓 <video> 本身（1920×1080、没有界面、没有弹幕），
// 不糊（只经 JPEG 一次压缩）；故事板上限三张，但不要求铺满，剩余空间就切细一点。
//
// 页面里的采集器只把帧存在内存里（Blob），拼图也在页面里直接画好再回传——
// 这样 Node 侧只收 1–3 张故事板（每张几百 KB），不用把几百帧搬过 CDP。
//
// 纯函数（选点 / 分张）单独导出，方便离线单测；页面里那两个函数必须自包含，不能引用模块变量。

export const GRAB_DEFAULTS = Object.freeze({
  intervalMs: 500,      // 2fps
  maxFrames: 900,       // 7.5 分钟；再长就只留每 1 秒一张（由页面自动降频）
  maxSheets: 3,
  minCells: 9,
  maxCells: 16,
  secondsPerCell: 4,    // 目标密度：每 4 秒一格，再夹到 9–48 格
  cellWidth: 480,
  portraitCellWidth: 340,   // 竖屏作品用更窄的格子，否则 16 格拼出来太宽太高
  minTailCells: 6,      // 最后一张凑不满 6 格就不拼（2026-10-29 主人定）
  labelHeight: 24,
  quality: 0.86,
});

// 格数 → 张数。2026-10-29 主人定：上限还是 3 张，但**每张尽量装满 16 格**，
// 最后一张凑不满 minTail（6 格）就不拼——省一张图，代价是结尾最后几秒没有画面。
// 例：17 格 → 只出 16 格一张；22 格 → 16+6 两张；33 格 → 16+16（丢掉最后 1 格）。
export function planSheets(cells, { maxSheets = 3, maxCells = 16, minTail = 6 } = {}) {
  const total = Math.max(0, Math.floor(cells));
  if (!total) return [];
  const sheets = [];
  let left = total;
  while (left > 0 && sheets.length < maxSheets) {
    if (left <= maxCells) {
      if (sheets.length && left < minTail) break;
      sheets.push(left);
      left = 0;
      break;
    }
    sheets.push(maxCells);
    left -= maxCells;
  }
  return sheets;
}

// 一条视频要切几格：按「每 4 秒一格」估，夹在 9 格到 3×16 格之间。
export function planCells(duration, { minCells = 9, maxCells = 16, maxSheets = 3, secondsPerCell = 4 } = {}) {
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : 30;
  const estimate = Math.round(seconds / secondsPerCell);
  return Math.max(minCells, Math.min(maxCells * maxSheets, estimate));
}

// 选点：先按时间均匀铺满（保证覆盖率），再在每个小窗口里挪到"变化最大"的那一帧附近。
// scores[i] 是第 i 帧相对上一帧的平均像素差（0–1）；第 0 帧分数为 0。
// lums：每帧平均亮度（0–1）。2026-10-29 实测：变化最大的帧常是"淡出到黑"的那一帧，
// 16 格里能有 2 格全黑，白占位置。近黑的帧只当备胎（除非窗口里没有别的可挑）。
export function chooseIndices({ times, scores, lums = null, cells }) {
  const n = Array.isArray(times) ? times.length : 0;
  if (!n) return [];
  const want = Math.max(1, Math.min(cells || n, n));
  if (want >= n) return times.map((_, index) => index);
  const picked = new Set([0, n - 1]);
  const slots = Math.max(1, want - 2);
  const step = (n - 1) / (slots + 1);
  for (let slot = 1; slot <= slots; slot += 1) {
    const center = Math.round(slot * step);
    const half = Math.max(1, Math.floor(step / 2));
    let best = center;
    let bestScore = -1;
    for (let index = Math.max(1, center - half); index <= Math.min(n - 2, center + half); index += 1) {
      if (picked.has(index)) continue;
      const brightness = lums?.[index];
      const dark = Number.isFinite(brightness) && brightness < 0.08;
      const score = (Number(scores?.[index]) || 0) - (dark ? 1 : 0);
      // 分数相同时取更靠近中心的，避免全挤在窗口边缘
      if (score > bestScore || (score === bestScore && Math.abs(index - center) < Math.abs(best - center))) {
        best = index;
        bestScore = score;
      }
    }
    if (picked.has(best)) {
      for (let offset = 1; offset <= half * 2; offset += 1) {
        if (center + offset <= n - 2 && !picked.has(center + offset)) { best = center + offset; break; }
        if (center - offset >= 1 && !picked.has(center - offset)) { best = center - offset; break; }
      }
    }
    picked.add(best);
  }
  return [...picked].sort((a, b) => a - b);
}


// 采样用：在已有帧里，按 [首帧, 首帧+seconds] 均匀取 count 个时间点对应的帧下标。
// 2026-10-29 实测：新视频首帧常常到 2.3 秒才抓到（切片后播放器要先加载），
// 固定在 0/1.25/2.5/3.75/5 取点会全挤到同一帧上，最后只剩 3 格。
// 一段采集里如果混进了"重播后"的帧，只保留第一段（时间单调上升的那截）。
// 页面里的兜底已经拦了，这里再挡一层——故事板宁可少几格，也不要两条时间线。
export function trimToFirstPass(times) {
  const list = Array.isArray(times) ? times : [];
  for (let index = 1; index < list.length; index += 1) {
    if (Number.isFinite(list[index]) && Number.isFinite(list[index - 1]) && list[index] < list[index - 1] - 1) return list.slice(0, index);
  }
  return list.slice();
}

export function sampleIndices(times, { count = 5, seconds = 5 } = {}) {
  const list = Array.isArray(times) ? times.filter((time) => Number.isFinite(time)) : [];
  if (!list.length) return [];
  const want = Math.max(2, Math.min(8, count));
  const first = list[0];
  const span = Math.max(0.5, Number(seconds) || 5);
  const last = Math.min(list[list.length - 1], first + span);
  const targets = Array.from({ length: want }, (_, index) => first + (index * (last - first)) / Math.max(1, want - 1));
  const picked = [];
  for (const target of targets) {
    let best = -1, bestGap = Infinity;
    list.forEach((time, index) => { const gap = Math.abs(time - target); if (gap < bestGap) { bestGap = gap; best = index; } });
    if (best >= 0 && !picked.includes(best)) picked.push(best);
  }
  return picked.sort((a, b) => a - b);
}

// ===== 以下两个函数会被 page.evaluate 序列化进浏览器：必须自包含 =====

// 安装采集器：每 500ms 把正在播的 video 画进 canvas，存成 JPEG Blob + 一个 120×68 的灰度签名。
export function installFrameGrabber() {
  if (window.__dshGrab && window.__dshGrab.version === 2) return 'already';
  const state = {
    version: 2, running: false, videoId: null, frames: [], errors: [],
    intervalMs: 500, maxFrames: 900, startedAt: 0, timer: null,
  };
  window.__dshGrab = state;
  const signature = document.createElement('canvas');
  signature.width = 120;
  signature.height = 68;
  const sigContext = signature.getContext('2d', { willReadFrequently: true });
  const full = document.createElement('canvas');
  const fullContext = full.getContext('2d');
  let previous = null;
  let busy = false;
  const pick = () => {
    const list = [...document.querySelectorAll('video')].map((video) => {
      const rect = video.getBoundingClientRect();
      return { video, area: Math.max(0, rect.width) * Math.max(0, rect.height), playing: !video.paused && video.readyState >= 2 };
    }).filter((item) => item.area > 0 && item.playing && item.video.videoWidth > 0);
    list.sort((a, b) => b.area - a.area);
    return list[0]?.video || null;
  };
  const shot = async () => {
    if (!state.running || busy) return;
    busy = true;
    try {
      const video = pick();
      if (!video) { state.errors.push('no-video'); return; }
      // 抖音播完会自动从头重播：时间倒退就收工，别把第二遍的画面混进这一条的故事板
      // （2026-10-29 首轮实测：29 秒作品存了 74 帧，故事板时间从 27.9 秒跳回 0.1 秒）。
      const current = video.currentTime;
      if (Number.isFinite(state.lastT) && current < state.lastT - 1) {
        state.running = false;
        window.clearInterval(state.timer);
        state.timer = null;
        state.wrapped = true;
        return;
      }
      state.lastT = current;
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      if (full.width !== width || full.height !== height) { full.width = width; full.height = height; }
      fullContext.drawImage(video, 0, 0, width, height);
      sigContext.drawImage(video, 0, 0, signature.width, signature.height);
      // 有的页面视频是跨域直链（file:// 或别的 CDN），画进 canvas 会污染画布、getImageData 直接抛。
      // 抓帧本身不受影响，差的只是"变化有多大"这个分数：拿不到就给 0，选点会退回均匀铺满。
      let sum = 0, lum = null;
      try {
        const data = sigContext.getImageData(0, 0, signature.width, signature.height).data;
        let total = 0;
        for (let index = 0; index < data.length; index += 4) total += data[index];
        lum = total / (signature.width * signature.height) / 255;
        if (previous && previous.length === data.length) {
          for (let index = 0; index < data.length; index += 4) sum += Math.abs(data[index] - previous[index]);
          sum = sum / (signature.width * signature.height) / 255;
        }
        previous = new Uint8ClampedArray(data);
      } catch { previous = null; }
      const blob = await new Promise((resolve) => full.toBlob(resolve, 'image/jpeg', 0.86));
      if (!blob) return;
      // 2026-10-29 实测：toBlob 要 50–100ms，这段时间视频可能正好播完回 0，
      // 于是"检测时 75.58 秒"被记成"0.22 秒"，下一帧又接上第二遍，故事板里就出现两条时间线。
      // 拍完再核一次：时间倒退就丢掉这一帧并收工；否则一律用检测时读到的 current。
      if (video.currentTime < current - 1) {
        state.running = false;
        window.clearInterval(state.timer);
        state.timer = null;
        state.wrapped = true;
        return;
      }
      state.frames.push({ t: Math.round(current * 100) / 100, score: Number(sum.toFixed(4)), lum, blob, w: width, h: height });
      // 内存兜底：超过上限就改成 1 秒补一张（丢掉每隔一帧），不无限涨。
      if (state.frames.length > state.maxFrames) {
        state.frames = state.frames.filter((_, index) => index % 2 === 0);
        state.intervalMs = Math.min(2000, state.intervalMs * 2);
        window.clearInterval(state.timer);
        state.timer = window.setInterval(shot, state.intervalMs);
      }
    } catch (error) {
      state.errors.push(String((error && error.message) || error).slice(0, 120));
    } finally { busy = false; }
  };
  state.start = (options = {}) => {
    state.videoId = String(options.videoId || '');
    state.intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 500;
    state.maxFrames = Number(options.maxFrames) > 0 ? Number(options.maxFrames) : 900;
    state.frames = [];
    state.errors = [];
    state.startedAt = Date.now();
    state.lastT = null;
    state.wrapped = false;
    previous = null;
    state.running = true;
    window.clearInterval(state.timer);
    state.timer = window.setInterval(shot, state.intervalMs);
    return { started: true, intervalMs: state.intervalMs };
  };
  state.stop = () => {
    state.running = false;
    window.clearInterval(state.timer);
    state.timer = null;
    return { frames: state.frames.length, videoId: state.videoId, errors: state.errors.slice(-3) };
  };
  state.meta = () => ({
    running: state.running, videoId: state.videoId, frames: state.frames.length,
    times: state.frames.map((frame) => frame.t), scores: state.frames.map((frame) => frame.score),
    lums: state.frames.map((frame) => (Number.isFinite(frame.lum) ? Number(frame.lum.toFixed(3)) : null)),
    wrapped: Boolean(state.wrapped),
    errors: state.errors.slice(-3),
  });
  state.reset = () => { state.frames = []; state.errors = []; previous = null; return true; };
  return 'installed';
}

// 在页面里把选中的几帧拼成 1–3 张故事板，直接返回 JPEG dataURL（帧不出页面）。
// groups 是二维数组：每组一张故事板，元素是该组要用的帧下标。
export function composeStoryboardSheets({ groups, cellWidth = 480, labelHeight = 24, gap = 6, quality = 0.86, columns: columnOverride = 0 }) {
  const grab = window.__dshGrab;
  if (!grab || !grab.frames.length) throw new Error('页面里没有抽到的帧。');
  const sheets = [];
  for (const group of groups) {
    const frames = group.map((index) => grab.frames[index]).filter(Boolean);
    if (frames.length < 1) continue;
    // 列数尽量整除：8 格 4 列、9 格 3 列、12/16 格 4 列，不留空格子。
    // 2026-10-29 实测：10 格配 4 列会在右下角留两个空格子。优先选能整除的列数（4/3/5），
    // 都除不尽才退回 3 或 4。
    const columns = Number(columnOverride) > 0
      ? Math.max(1, Math.min(6, Math.floor(Number(columnOverride))))
      : frames.length % 4 === 0 ? 4
      : frames.length % 3 === 0 ? 3
      : frames.length % 5 === 0 ? 5
      : (frames.length <= 9 ? 3 : 4);
    const rows = Math.ceil(frames.length / columns);
    // 格子按视频真实比例（抖音多是竖屏 1080×1920），别硬压成 16:9 把画面拉变形。
    const aspect = frames[0] && frames[0].w > 0 && frames[0].h > 0 ? frames[0].h / frames[0].w : 9 / 16;
    // 竖屏作品格子窄一点，四列十六格才不会拼成一张 4000 多像素高的长图。
    const baseWidth = aspect > 1.2 ? Math.min(Number(cellWidth) || 480, 340) : (Number(cellWidth) || 480);
    const cellHeight = Math.round(baseWidth * Math.min(2.2, Math.max(0.4, aspect)));
    const width = columns * baseWidth + (columns - 1) * gap;
    const height = rows * (cellHeight + labelHeight) + (rows - 1) * gap;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#101014';
    context.fillRect(0, 0, width, height);
    // 最后一行不满时居中，别让空格子看起来像"少抓了一帧"。
    const xFor = (index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const inRow = Math.min(columns, frames.length - row * columns);
      const rowWidth = inRow * baseWidth + (inRow - 1) * gap;
      return Math.round((width - rowWidth) / 2 + column * (baseWidth + gap));
    };
    frames.forEach((frame, index) => {
      const row = Math.floor(index / columns);
      const x = xFor(index);
      const y = row * (cellHeight + labelHeight + gap);
      context.fillStyle = '#000';
      context.fillRect(x, y, baseWidth, labelHeight);
      context.fillStyle = '#e8e8e8';
      context.font = '17px monospace';
      context.textBaseline = 'middle';
      const label = String(Math.floor(frame.t / 60)).padStart(2, '0') + ':' + String(Math.floor(frame.t % 60)).padStart(2, '0') + '.' + String(Math.floor((frame.t % 1) * 10));
      context.fillText(label, x + 6, y + labelHeight / 2 + 1);
      context.fillStyle = '#222';
      context.fillRect(x, y + labelHeight, baseWidth, cellHeight);
    });
    // 画帧本身要异步解码，先摆好底板再把图贴上去。
    const images = frames.map((frame, index) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const row = Math.floor(index / columns);
        context.drawImage(image, xFor(index), row * (cellHeight + labelHeight + gap) + labelHeight, baseWidth, cellHeight);
        URL.revokeObjectURL(image.src);
        resolve(true);
      };
      image.onerror = () => resolve(false);
      image.src = URL.createObjectURL(frame.blob);
    }));
    // drawImage 是同步的，但 onload 是异步的：这里先等全部解码完再导出。
    sheets.push({ wait: Promise.all(images), canvas, times: frames.map((frame) => frame.t), columns });
  }
  return Promise.all(sheets.map(async (sheet) => {
    await sheet.wait;
    return {
      dataUrl: sheet.canvas.toDataURL('image/jpeg', quality),
      width: sheet.canvas.width, height: sheet.canvas.height,
      times: sheet.times, columns: sheet.columns,
    };
  }));
}