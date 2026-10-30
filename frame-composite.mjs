// 把同一秒段里的多帧画面拼成一张图，只让模型读一张，但保留时间顺序。
// 2026-10-27 主人定：开头 3 秒的采样（0 / 1.5 / 3 秒）合成一张；第二轮之后
// 的观察（2 秒间隔）连同中段帧合成一张。模型在同一个画面里从左到右、
// 从上到下读时间线，比只送首尾两帧更容易看出「画面有没有在动」。
//
// composeFramesInPage 会被 page.evaluate() 序列化后送进浏览器执行，
// 所以它只能使用页面里的 Image / document / canvas，不能引用模块里的其它变量。
// cellHeight = 0 表示按原图高度拼（不人工缩放）；2026-10-27 主人算过：5 格原尺寸约 2367×1612（含 8px 间隙和 26px 标签是 2383×1672）也只有几百 KB，2 MB 的附件上限远没到。
// cropRight / cropBottom 是裁掉右侧点赞栏和底部标题/话题的比例（0–0.5）；cropRightPx / cropBottomPx 是按源图像素的固定裁切（更适合不同窗口宽度，UI 是固定像素）。
// 只裁拼图，不改编码后的原始帧。
export const COMPOSITE_DEFAULTS = Object.freeze({ columns: 3, cellHeight: 0, gap: 8, labelHeight: 26, quality: 0.82, cropRight: 0, cropBottom: 0, cropRightPx: 0, cropBottomPx: 0 });

export async function composeFramesInPage({ frames, columns = 3, cellHeight = 0, gap = 8, labelHeight = 26, quality = 0.82, cropRight = 0, cropBottom = 0, cropRightPx = 0, cropBottomPx = 0 }) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('没有可拼图的画面。');
  const images = [];
  for (const frame of frames) {
    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('拼图时有一帧解码失败。'));
    });
    image.src = 'data:' + (frame.mimeType || 'image/jpeg') + ';base64,' + frame.data;
    await loaded;
    images.push(image);
  }
  const first = images[0];
  const trimRight = Math.min(0.5, Math.max(0, Number(cropRightPx) > 0 ? Number(cropRightPx) / first.naturalWidth : Number(cropRight) || 0));
  const trimBottom = Math.min(0.5, Math.max(0, Number(cropBottomPx) > 0 ? Number(cropBottomPx) / first.naturalHeight : Number(cropBottom) || 0));
  const cropWidth = Math.max(1, Math.round(first.naturalWidth * (1 - trimRight)));
  const cropHeight = Math.max(1, Math.round(first.naturalHeight * (1 - trimBottom)));
  const aspect = cropWidth / cropHeight;
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('拼图帧的尺寸无效。');
  // cellHeight 为 0 时用第一帧裁剪后的原始高度：拼图不压缩，只交给 2 MB 上限兜底。
  const targetHeight = Number(cellHeight) > 0 ? Math.round(cellHeight) : cropHeight;
  const cellWidth = Math.max(1, Math.round(targetHeight * aspect));
  const cols = Math.min(Math.max(1, Math.floor(columns)), images.length);
  const rows = Math.ceil(images.length / cols);
  const width = cols * cellWidth + (cols - 1) * gap;
  const height = rows * (targetHeight + labelHeight) + (rows - 1) * gap;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > 24_000_000) throw new Error('拼图尺寸超出限制。');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器没有提供画布。');
  context.fillStyle = '#101014';
  context.fillRect(0, 0, width, height);
  images.forEach((image, index) => {
    const row = Math.floor(index / cols);
    const column = index % cols;
    const inRow = Math.min(cols, images.length - row * cols);
    const rowWidth = inRow * cellWidth + (inRow - 1) * gap;
    const x = Math.round((width - rowWidth) / 2 + column * (cellWidth + gap));
    const y = row * (targetHeight + labelHeight + gap);
    context.fillStyle = '#000';
    context.fillRect(x, y, cellWidth, labelHeight);
    context.fillStyle = '#e8e8e8';
    context.font = '18px monospace';
    context.textBaseline = 'middle';
    const frame = frames[index];
    const label = String(frame?.label || (Number.isFinite(frame?.time) ? Number(frame.time).toFixed(1) + 's' : '#' + (index + 1)));
    context.fillText(label, x + 8, y + labelHeight / 2 + 1, cellWidth - 16);
    const imageTrimRight = Number(cropRightPx) > 0 ? Math.min(0.5, Math.max(0, Number(cropRightPx) / image.naturalWidth)) : trimRight;
    const imageTrimBottom = Number(cropBottomPx) > 0 ? Math.min(0.5, Math.max(0, Number(cropBottomPx) / image.naturalHeight)) : trimBottom;
    const sourceWidth = Math.max(1, Math.round(image.naturalWidth * (1 - imageTrimRight)));
    const sourceHeight = Math.max(1, Math.round(image.naturalHeight * (1 - imageTrimBottom)));
    const scale = Math.min(cellWidth / sourceWidth, targetHeight / sourceHeight);
    const drawWidth = Math.round(sourceWidth * scale);
    const drawHeight = Math.round(sourceHeight * scale);
    context.drawImage(image, 0, 0, sourceWidth, sourceHeight, x + Math.round((cellWidth - drawWidth) / 2), y + labelHeight + Math.round((targetHeight - drawHeight) / 2), drawWidth, drawHeight);
  });
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), width, height, cellWidth, cellHeight: targetHeight, crop: { right: trimRight, bottom: trimBottom } };
}

// Node 侧先验一遍，避免把坏帧送进页面再等一个难懂的报错。
export function prepareCompositeFrames(frames, { maxFrames = 8, maxBytes = 2_000_000 } = {}) {
  if (!Array.isArray(frames) || frames.length < 2) throw new Error('拼图至少需要两帧画面。');
  if (frames.length > maxFrames) throw new Error('拼图最多 ' + maxFrames + ' 帧。');
  return frames.map((frame) => {
    const mimeType = String(frame?.mimeType || '');
    const data = String(frame?.data || '');
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) throw new Error('拼图输入里有无效的图片帧。');
    if (Buffer.byteLength(data, 'base64') > maxBytes) throw new Error('拼图输入里有超过大小限制的画面。');
    return { mimeType, data, time: Number.isFinite(frame.time) ? frame.time : null, videoId: frame.videoId || null, label: frame.label || null };
  });
}

// 同一秒附近的两帧只留后一张：连看段末尾的补帧和下一次观察的首帧常常只差 0.2–0.5 秒，
// 拼在一起就是两张几乎一样的格子。默认 1.2 秒以内算重复（小于 2 秒观察间隔），保留更晚的（观察帧）。
export function dedupeFramesByTime(frames, minGap = 1.2) {
  if (!Array.isArray(frames)) return [];
  const unique = [];
  for (const frame of frames) {
    const last = unique[unique.length - 1];
    if (last && Number.isFinite(last.time) && Number.isFinite(frame?.time) && Math.abs(last.time - frame.time) < minGap) {
      unique[unique.length - 1] = frame;
      continue;
    }
    unique.push(frame);
  }
  return unique;
}
