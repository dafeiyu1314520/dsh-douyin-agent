// danmaku.mjs —— 弹幕（aweme/v1/web/danmaku/get_v2/）的纯函数部分。
// 2026-10-29 主人定：评论要带「打上时间的高赞弹幕」；弹幕是观众反应，可能是玩梗/反讽，不是画面事实。
// 这里只做三件事：按赞数挑前 N 条、把 offset_time 归一成秒、排成带 [mm:ss] 的文本。

const num = (value) => (Number.isFinite(value) ? value : Number.isFinite(Number(value)) ? Number(value) : null);

// 时间戳归一：接口不同版本有的给毫秒、有的给秒。整条的 offset_time 明显超过时长就按毫秒算。
export function danmakuSeconds(list, duration = null) {
  const raw = (Array.isArray(list) ? list : []).map((item) => num(item?.offset_time)).filter((value) => value !== null && value >= 0);
  if (!raw.length) return { scale: 1, max: 0 };
  const max = Math.max(...raw);
  const scale = Number.isFinite(duration) && duration > 0 ? (max > duration * 1.5 ? 0.001 : 1) : (max > 600 ? 0.001 : 1);
  return { scale, max };
}

export const stamp = (seconds) => {
  // 注意 Number(null) === 0：这里必须先挡掉空值，别把"没有时间"写成 00:00。
  if (seconds === null || seconds === undefined || seconds === '') return '--:--';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '--:--';
  const total = Math.floor(value);
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};

// 只要前 maxTime 秒里的弹幕（采样决策用：整条 top-20 里最赞的往往是结尾的爆点，不是开头的信号）。
export function danmakuWithin(list, maxTime, duration = null) {
  const items = Array.isArray(list) ? list : [];
  if (!Number.isFinite(maxTime) || maxTime <= 0) return items;
  const { scale } = danmakuSeconds(items, duration);
  return items.filter((item) => {
    const raw = Number(item?.offset_time);
    return Number.isFinite(raw) && raw * scale <= maxTime;
  });
}

// 高赞优先；同一条文案只留一次（刷屏的「哈哈」），时间取最早那次。
export function pickTopDanmaku(list, { limit = 20, duration = null, minLikes = 1 } = {}) {
  const { scale } = danmakuSeconds(list, duration);
  const seen = new Set();
  const picked = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = String(item?.text ?? '').trim();
    if (!text) continue;
    const likes = num(item?.digg_count) ?? 0;
    if (likes < minLikes) continue;
    const key = text.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const seconds = (num(item?.offset_time) ?? 0) * scale;
    picked.push({ time: Math.round(seconds * 10) / 10, text, likes });
  }
  picked.sort((a, b) => (b.likes - a.likes) || (a.time - b.time));
  return picked.slice(0, Math.max(0, limit));
}

// 给评论模型的文本：每条一行，带时间。空列表返回空串，调用方据此不加这一段。
export function formatDanmaku(picks, { limit = 20 } = {}) {
  const list = (Array.isArray(picks) ? picks : []).slice(0, limit);
  if (!list.length) return '';
  return list.map((item) => '[' + stamp(item.time) + '] ❤' + (item.likes ?? 0) + ' ' + item.text).join('\n');
}

// 抓到的请求 URL 存成模板（item_id/aweme_id 换成占位），换个作品时重新拼一次。
export function danmakuUrlTemplate(url) {
  try {
    const parsed = new URL(url);
    for (const key of ['item_id', 'aweme_id', 'group_id']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '__ID__');
    }
    return parsed.toString();
  } catch { return null; }
}

export function danmakuUrlFor(template, videoId) {
  if (!template || !/^\d{6,40}$/.test(String(videoId || ''))) return null;
  return template.replace(/__ID__/g, String(videoId));
}
