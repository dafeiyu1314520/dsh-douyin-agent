// capture-session.mjs —— 一条视频可以有多段采集（私信插进来、被打断、再回来继续）。
// 2026-10-29 主人定：换片/按住时**不丢帧**，只切段；同一条视频回来后开新段，最后合成一份 manifest。
// 2026-10-29 晚修：①每次拼图（含开头采样那张）都要记帧，以前只记观察，manifest 才会一直是 0；
// ②换一轮时会新建 CaptureSession，finalize 不能把上一轮已经写好的 manifest 覆盖掉，改成按 videoId 合并；
// ③轮次收尾要 finalizeAll，别只收 track 上那一条。
import fs from 'node:fs';
import path from 'node:path';

const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

export class CaptureSession {
  constructor({ dir, runId = null, segmentsFile = null, now = () => Date.now() } = {}) {
    if (!dir) throw new Error('采集目录不能为空。');
    this.dir = dir;
    this.runId = runId;
    // 滚动转写的分段索引（tools\sensevoice\roll_capture.mjs 写的那份）。
    // 音频没有 videoId，只能按墙钟把落在这一段采集窗口里的音频段归到这条视频。
    this.segmentsFile = segmentsFile;
    this.now = now;
    this.records = new Map();   // videoId -> { videoId, url, parts: [] }
    this.active = null;         // { videoId, part }
  }

  begin({ videoId, url = null } = {}) {
    if (!/^\d{6,40}$/.test(String(videoId || ''))) throw new Error('采集必须绑定有效的作品 id。');
    if (this.active?.videoId === videoId) return this.active.part;
    // 换到另一条：把上一条直接封存，别让它只活在内存里。
    if (this.active) this.finalize(this.active.videoId, '换片');
    if (!this.records.has(videoId)) this.records.set(videoId, { videoId, url, parts: [] });
    const rec = this.records.get(videoId);
    const part = { run: this.runId, startedAt: this.now(), endedAt: null, frames: [], audio: [], reason: null };
    rec.parts.push(part);
    if (url) rec.url = url;
    this.active = { videoId, part };
    return part;
  }

  // 只收当前段的帧；别的视频的帧丢弃，但同一条视频后来续上的段会被接受（因为 active 已经切过去了）。
  addFrame({ videoId, time, file = null } = {}) {
    if (!this.active || videoId !== this.active.videoId) return false;
    this.active.part.frames.push({ time: round1(time), file });
    return true;
  }

  // 一张拼图有 2–6 格，每格都是这条视频上的一个时刻；按整张记，manifest 才能还原"哪几秒进过图"。
  addFrames({ videoId, times, file = null } = {}) {
    if (!this.active || videoId !== this.active.videoId) return 0;
    const list = (Array.isArray(times) ? times : []).filter((time) => Number.isFinite(time));
    for (const time of list) this.active.part.frames.push({ time: round1(time), file });
    return list.length;
  }

  setAudio({ file, seconds } = {}) {
    if (!this.active) return false;
    this.active.part.audio.push({ file, seconds: Number.isFinite(seconds) ? seconds : null });
    return true;
  }

  // 滚动转写的每一段都带墙钟时间；按段落的起止把它归到当时正在采集的那条视频。
  noteAudio({ from, to, file = null, bytes = null } = {}) {
    if (!this.active) return false;
    const start = Number.isFinite(from) ? from : this.now();
    const end = Number.isFinite(to) ? to : start;
    this.active.part.audio.push({ from: start, to: end, file, bytes });
    return true;
  }

  // 把这一段的墙钟窗口里录到的音频段找出来（只读 segments.jsonl，不搬音频文件）。
  audioInWindow(from, to) {
    if (!this.segmentsFile || !Number.isFinite(from) || !Number.isFinite(to)) return [];
    try {
      const lines = fs.readFileSync(this.segmentsFile, 'utf8').split('\n').filter(Boolean);
      const hits = [];
      for (const line of lines) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (!Number.isFinite(item?.at)) continue;
        if (item.at < from || item.at >= to) continue;
        hits.push({ file: item.file ?? null, from: item.from ?? null, to: item.to ?? null, bytes: item.bytes ?? null });
      }
      return hits;
    } catch { return []; }
  }

  endPart(reason = '结束') {
    if (!this.active) return null;
    const part = this.active.part;
    part.endedAt = this.now();
    part.reason = reason;
    this.active = null;
    return part;
  }

  // 私信按住：只切段，不封存；回来还能续上同一份记录。
  hold(reason = '私信按住') {
    return this.endPart(reason);
  }

  // 轮次结束或确认换片：把记录写成 manifest（多段合并，并与磁盘上已有的那份合并）。
  finalize(videoId, reason = '结束') {
    const rec = this.records.get(videoId);
    if (!rec) return null;
    if (this.active?.videoId === videoId && !this.active.part.endedAt) this.endPart(reason);
    const parts = rec.parts.slice();
    // 磁盘上可能已经有同一条作品、别的轮次写下的段：并进来，不能把上一轮覆盖掉。
    const target = path.join(this.dir, rec.videoId + '-manifest.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { previous = null; }
    const oldParts = Array.isArray(previous?.parts) ? previous.parts : [];
    const seen = new Set(parts.map((part) => part.startedAt));
    const merged = oldParts.filter((part) => Number.isFinite(part?.startedAt) && !seen.has(part.startedAt)).concat(parts);
    const frames = merged.flatMap((part) => (Array.isArray(part.frames) ? part.frames : []));
    for (const part of merged) {
      if (Array.isArray(part.audio) && part.audio.length) continue;
      part.audio = this.audioInWindow(part.startedAt, part.endedAt ?? this.now());
    }
    const audio = merged.flatMap((part) => (Array.isArray(part.audio) ? part.audio : []));
    const manifest = {
      version: 2,
      videoId: rec.videoId,
      url: rec.url ?? previous?.url ?? null,
      parts: merged.map((part) => ({
        run: part.run ?? null,
        startedAt: part.startedAt ?? null,
        endedAt: part.endedAt ?? null,
        reason: part.reason ?? null,
        frames: Array.isArray(part.frames) ? part.frames : [],
        audio: Array.isArray(part.audio) ? part.audio : [],
      })),
      totalFrames: frames.length,
      interrupted: merged.length > 1,
      frames,
      audio,
      sheets: previous?.sheets ?? [],
      updatedAt: new Date(this.now()).toISOString(),
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(target, JSON.stringify(manifest, null, 1));
    } catch { /* 写不进 manifest 不影响采集 */ }
    this.records.delete(videoId);
    return manifest;
  }

  // 轮次收尾：内存里还有哪条没写，全写掉；active 那一段按 reason 收口。
  finalizeAll(reason = '结束') {
    const written = [];
    for (const videoId of [...this.records.keys()]) {
      if (this.active?.videoId === videoId) this.endPart(reason);
      const manifest = this.finalize(videoId, reason);
      if (manifest) written.push(manifest.videoId);
    }
    return written;
  }

  // 给评论模型看的摘要：几段、几帧、有没有被私信打断、覆盖了哪些秒。
  summary(videoId) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(this.dir, videoId + '-manifest.json'), 'utf8'));
      const times = (manifest.frames || []).map((item) => item.time).filter((time) => Number.isFinite(time));
      return {
        videoId,
        parts: (manifest.parts || []).length,
        interrupted: Boolean(manifest.interrupted),
        frames: times.length,
        from: times.length ? Math.min(...times) : null,
        to: times.length ? Math.max(...times) : null,
        reasons: [...new Set((manifest.parts || []).map((part) => part.reason).filter(Boolean))],
      };
    } catch { return null; }
  }
}
