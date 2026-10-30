import fs from 'node:fs';
import path from 'node:path';

// 自主观看收尾时把「这一条看了什么」写进共享日记。
// 格式与 diary/digest.py 对齐：标题行 + 正文 + `- 看过：`（5 段）+ 可选 `- 想对你说：`。
export const DIARY_PLATFORM = '抖音';
const DEFAULT_DIARY = 'D:\\Deep\\diary\\肥鱼日记.md';
const DEFAULT_PRIVATE = 'D:\\Deep\\diary\\自己看的肥鱼日记.md';
const stampParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function diaryFile(env = process.env) {
  const configured = env.DOUYIN_DIARY_FILE?.trim();
  return configured || DEFAULT_DIARY;
}

export function privateDiaryFile(env = process.env) {
  const configured = env.DOUYIN_PRIVATE_DIARY_FILE?.trim();
  return configured || DEFAULT_PRIVATE;
}

function appendText(file, entry) {
  try {
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4_000_000) return '';
    let prefix = '';
    if (stat.size > 0) {
      const handle = fs.openSync(file, 'r');
      try { const buffer = Buffer.alloc(1); fs.readSync(handle, buffer, 0, 1, stat.size - 1); if (buffer.toString('utf8') !== '\n') prefix = '\n'; }
      finally { fs.closeSync(handle); }
    }
    fs.appendFileSync(file, prefix + entry, { encoding: 'utf8' });
    return entry;
  } catch { return ''; }
}

export function diaryStamp(at = Date.now()) {
  const parts = Object.fromEntries(stampParts.formatToParts(new Date(at)).map((item) => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function cleanText(value, maximum) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maximum);
}

function oneLine(value, maximum) {
  return String(value ?? '').replace(/[\r\n\t｜|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function watchProgress({ duration, position, ended = false } = {}) {
  if (ended === true) return '看完';
  const seconds = Number(position);
  if (!Number.isFinite(seconds) || seconds <= 0) return '开始几秒';
  if (seconds < 5) return `${Math.round(seconds)} 秒`;
  if (!Number.isFinite(duration) || duration <= 0) return clock(seconds);
  return `${clock(seconds)} / ${clock(duration)}（${Math.round((Math.min(seconds, duration) / duration) * 100)}%）`;
}

// 追加一条日记；返回实际写入的文本，跳过时返回空串。只在文件已存在时追加，不替用户新建日记。
// 2026-10-28 主人定：日记只记「看了哪条视频」，不再写正文，也没有「想对你说」。
export function appendWatchEntry({ file = diaryFile(), at = Date.now(), title, videoId, duration, position, ended = false, action = '停' } = {}) {
  const id = String(videoId ?? '').trim();
  const heading = oneLine(title, 160) || '未读到的作品标题';
  if (!/^\d{6,40}$/.test(id)) return '';
  if (action !== '停' && action !== '划') return '';
  const line = [heading, id, Number.isFinite(duration) && duration > 0 ? clock(duration) : '—', watchProgress({ duration, position, ended }), action];
  const entry = `\n## ${diaryStamp(at)} · ${DIARY_PLATFORM}\n\n- 看过：${line.join(' ｜ ')}\n`;
  return appendText(file, entry);
}

// 私人那本：只有标题和正文，没有结构化尾行；写不写由人格自己决定。
export function appendPrivateEntry({ file = privateDiaryFile(), at = Date.now(), body = '' } = {}) {
  const text = cleanText(body, 600);
  if (!text) return '';
  return appendText(file, `\n## ${diaryStamp(at)} · ${DIARY_PLATFORM}\n\n${text}\n`);
}
