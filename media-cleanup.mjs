// media-cleanup.mjs —— 清理看过的图片（2026-10-30 主人定：删两天前的）。
// 只按文件修改时间判断，不碰当天的；删单个文件失败不影响其它文件。
// 为什么要有这个：故事板和拼图每一条视频都落盘（主人要能回看完整过程），
// 一天能攒 100–200 MB，不清理会一直涨。
import fs from 'node:fs';
import path from 'node:path';

// match 只清文件名匹配的（可选）：rolling 目录里只删 seg-*.webm / .done，别碰 segments.jsonl。
export function cleanupOldMedia(dirs, { maxAgeDays = 2, now = Date.now, match = null } = {}) {
  // now 允许传函数（watcher 里的 this.now）或毫秒数（测试用）。
  const reference = typeof now === 'function' ? now() : (Number.isFinite(now) ? now : Date.now());
  const cutoff = reference - maxAgeDays * 86_400_000;
  const removed = {};
  const kept = {};
  for (const dir of dirs) {
    const name = path.basename(dir);
    removed[name] = 0;
    kept[name] = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // 目录不存在就算了
    }
    for (const entry of entries) {
      const file = path.join(dir, entry);
      try {
        if (match && !(match instanceof RegExp ? match.test(entry) : match(entry))) continue;
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs >= cutoff) {
          kept[name] += 1;
          continue;
        }
        fs.unlinkSync(file);
        removed[name] += 1;
      } catch {
        // 单个文件删不掉（被占用/没权限）不影响其它文件
      }
    }
  }
  return { cutoff, removed, kept };
}
