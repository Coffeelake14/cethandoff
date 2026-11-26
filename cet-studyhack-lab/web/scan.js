// Shared browser-side photo import for the reading tool, the writing /
// translation graders and the lab's self-provided material.
//
// Photos are decoded, rotated, compressed in memory and sent once to the
// `scan` action; they are never persisted. A SHA-256 of the compressed bytes
// keys a session-local result cache, so re-opening the same photo does not
// spend credits again. The server repeats the dedupe for cross-tab requests.
import { consumeSSE } from './sse.mjs';
import { aiErrorMessage, requireFeature } from './shell.js';

const MAX_RAW_BYTES = 20 * 1024 * 1024;
const MAX_EDGE = 1600;
// The upstream model request rejects bodies over ~256KB; stay under it with margin.
const MAX_DATA_URL = 250000;
const MIN_EDGE = 800;
const API = '/functions/v1/app';
const localCache = new Map();
const LOCAL_CACHE_MAX = 12;

export function photoFileError(file) {
  if (!file) return '请选择一张照片。';
  const typeOk = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
    || /\.(jpe?g|png|webp)$/i.test(file.name || '');
  if (!typeOk) return '请选择 JPG / PNG / WebP 格式的照片；HEIC 请先转成 JPG。';
  if (file.size > MAX_RAW_BYTES) return '照片超过 20MB，请重新拍摄或压缩后再上传。';
  return '';
}

async function decodePhoto(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

const normRotate = value => ((Number(value) % 360) + 360) % 360;

/**
 * Compress and optionally rotate a photo. Rotation is applied while drawing so
 * the uploaded bytes and the preview show the same orientation.
 * @param {File|Blob} file
 * @param {{ rotate?: number }} [options]
 * @returns {Promise<string>} JPEG data URL
 */
export async function compressPhoto(file, { rotate = 0 } = {}) {
  const source = await decodePhoto(file);
  try {
    const w = source.width, h = source.height;
    if (!w || !h) throw new Error('图片无法读取，请换一张照片。');
    const deg = normRotate(rotate);
    const swap = deg === 90 || deg === 270;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const render = edge => {
      const scale = Math.min(1, edge / Math.max(w, h));
      const drawW = Math.max(1, Math.round(w * scale));
      const drawH = Math.max(1, Math.round(h * scale));
      canvas.width = swap ? drawH : drawW;
      canvas.height = swap ? drawW : drawH;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
      let url = canvas.toDataURL('image/jpeg', 0.85);
      for (let q = 0.78; url.length > MAX_DATA_URL && q >= 0.5; q -= 0.07) {
        url = canvas.toDataURL('image/jpeg', q);
      }
      return url;
    };
    let edge = MAX_EDGE;
    let dataUrl = render(edge);
    // Quality alone cannot always fit a dense page under the upstream cap, so
    // step the resolution down until it fits (or the readability floor is hit).
    while (dataUrl.length > MAX_DATA_URL && Math.max(canvas.width, canvas.height) > MIN_EDGE) {
      edge = Math.round(edge * 0.8);
      dataUrl = render(edge);
    }
    if (dataUrl.length > MAX_DATA_URL) throw new Error('照片内容过多，请只拍一页并靠近一些。');
    return dataUrl;
  } finally {
    if (typeof source.close === 'function') source.close();
  }
}

async function dataUrlDigest(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Decode + rotate + compress once, returning a previewable image and its hash.
 * @param {File|Blob} file
 * @param {{ rotate?: number }} [options]
 */
export async function preparePhoto(file, { rotate = 0 } = {}) {
  const dataUrl = await compressPhoto(file, { rotate });
  return { dataUrl, hash: await dataUrlDigest(dataUrl), rotate: normRotate(rotate) };
}

function cacheGet(key) {
  const hit = localCache.get(key);
  if (!hit) return null;
  localCache.delete(key);
  localCache.set(key, hit);
  return hit;
}
function cacheSet(key, value) {
  localCache.set(key, value);
  if (localCache.size > LOCAL_CACHE_MAX) localCache.delete(localCache.keys().next().value);
}

function normalizeResult(env) {
  const text = typeof env?.text === 'string' ? env.text.trim() : '';
  const doc = env?.kind || env?.questions || env?.student_answer || env?.passage ? {
    kind: typeof env.kind === 'string' ? env.kind : 'other',
    text,
    passage: typeof env.passage === 'string' ? env.passage : '',
    questions: Array.isArray(env.questions) ? env.questions : [],
    prompt_material: typeof env.prompt_material === 'string' ? env.prompt_material : '',
    student_answer: typeof env.student_answer === 'string' ? env.student_answer : '',
    uncertain: Array.isArray(env.uncertain) ? env.uncertain.filter(x => typeof x === 'string') : [],
    confidence: env.confidence,
    notes: typeof env.notes === 'string' ? env.notes : '',
  } : null;
  return {
    text,
    doc,
    confidence: env?.confidence,
    notes: typeof env?.notes === 'string' ? env.notes : '',
    cached: env?.cached === true,
    usage: env?.usage && typeof env.usage === 'object' ? env.usage : null,
    meta: env?.meta && typeof env.meta === 'object' ? env.meta : null,
    image: env?.__image || '',
    hash: env?.__hash || '',
  };
}

function emitUsage(onStatus, result) {
  if (!onStatus) return;
  const seconds = result.meta?.durationMs ? `${(result.meta.durationMs / 1000).toFixed(1)}s` : '';
  const credits = Number.isFinite(result.usage?.totalCredits) ? `${result.usage.totalCredits} credits` : '';
  const suffix = [seconds, credits].filter(Boolean).join('，');
  if (suffix) onStatus('done', `识别耗时 ${suffix}`);
}

/**
 * @param {File|Blob} file
 * @param {{ target: 'reading'|'writing'|'translation', level: 'CET4'|'CET6',
 *   structured?: boolean, rotate?: number, bypassCache?: boolean, signal?: AbortSignal,
 *   onStatus?: (state: string, text: string) => void,
 *   onPreview?: (dataUrl: string) => void }} options
 */
export async function transcribePhoto(file, {
  target, level, structured = false, rotate = 0, bypassCache = false,
  signal, onStatus, onPreview,
} = {}) {
  await requireFeature('scan');
  onStatus?.('loading', '正在压缩照片…');
  const prepared = await preparePhoto(file, { rotate });
  onPreview?.(prepared.dataUrl);
  const key = `${target}|${level}|${structured ? 1 : 0}|${prepared.hash}`;
  if (!bypassCache) {
    const hit = cacheGet(key);
    if (hit) {
      onStatus?.('done', '已复用这张照片的识别结果，未重复消耗额度。');
      return { ...hit, image: prepared.dataUrl, hash: prepared.hash };
    }
  }
  onStatus?.('loading', '正在识别文字…');
  const res = await fetch(`${API}?action=scan`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target, level, structured, image: prepared.dataUrl,
      ...(bypassCache ? { bypassCache: true } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    let msg = '识别请求失败。';
    let code = '';
    try { const j = await res.json(); if (j?.message) msg = j.message; if (j?.error) code = j.error; } catch { /* ignore */ }
    const error = new Error(aiErrorMessage({ code }, msg));
    error.code = code;
    throw error;
  }
  let result = null;
  await consumeSSE(res, frame => {
    let env; try { env = JSON.parse(frame.data); } catch { return false; }
    if (env.type === 'status') { onStatus?.('loading', env.message || '正在识别文字…'); return false; }
    if (env.type === 'result') { result = env; return false; }
    if (env.type === 'done') return true;
    if (env.type === 'error') {
      const code = env.code || '';
      const error = new Error(aiErrorMessage({ code }, env.message || '暂不可用，请重试。'));
      error.code = code;
      throw error;
    }
    return false;
  }, { signal });
  if (!result) throw new Error('识别没有返回结果，请重拍。');
  const normalized = normalizeResult(result);
  if (!normalized.text) throw new Error('没有识别到清晰文字，请正对纸张重拍。');
  normalized.image = prepared.dataUrl;
  normalized.hash = prepared.hash;
  cacheSet(key, { ...normalized, image: '', hash: '' });
  emitUsage(onStatus, normalized);
  return normalized;
}

export function confidenceLabel(confidence) {
  return confidence === 'high' ? '高' : confidence === 'low' ? '低' : '中';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * Escape a transcript and wrap uncertain fragments in <mark>. Longest phrases
 * win so nested markers do not split shorter ones.
 */
export function highlightUncertain(text, uncertain = []) {
  const source = String(text || '');
  const items = [...new Set(uncertain.filter(x => typeof x === 'string' && x.length >= 2))]
    .sort((a, b) => b.length - a.length);
  if (!source) return '';
  if (!items.length) return escapeHtml(source);
  const ranges = [];
  for (const item of items) {
    let from = 0;
    while (from < source.length && ranges.length < 80) {
      const at = source.indexOf(item, from);
      if (at < 0) break;
      if (!ranges.some(r => at < r.end && at + item.length > r.start)) ranges.push({ start: at, end: at + item.length });
      from = at + item.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let html = '';
  let cursor = 0;
  for (const range of ranges) {
    html += escapeHtml(source.slice(cursor, range.start));
    html += `<mark class="uncertain" title="识别不确定，请校对">${escapeHtml(source.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  return html + escapeHtml(source.slice(cursor));
}

export function imageFileFromDataTransfer(dataTransfer) {
  const items = dataTransfer?.items;
  if (items) {
    for (const item of items) {
      if (item.kind === 'file' && /^image\//.test(item.type)) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }
  const files = dataTransfer?.files;
  if (files) for (const file of files) if (/^image\//.test(file.type)) return file;
  return null;
}

/**
 * Wire drag/drop and paste on a container. Returns a cleanup function.
 * @param {HTMLElement} element
 * @param {(file: File) => void} onFile
 * @param {{ onError?: (message: string) => void, enabled?: () => boolean }} [options]
 */
export function wirePhotoDropPaste(element, onFile, { onError, enabled = () => true } = {}) {
  if (!element) return () => {};
  const handle = dataTransfer => {
    if (!enabled()) return false;
    const file = imageFileFromDataTransfer(dataTransfer);
    if (!file) return false;
    const err = photoFileError(file);
    if (err) { onError?.(err); return true; }
    onFile(file);
    return true;
  };
  const onDragOver = event => {
    if (!event.dataTransfer || !enabled()) return;
    event.preventDefault();
  };
  const onDrop = event => {
    if (!event.dataTransfer) return;
    const hasImage = Boolean(imageFileFromDataTransfer(event.dataTransfer));
    const handled = handle(event.dataTransfer);
    if (hasImage || handled) event.preventDefault();
  };
  const onPaste = event => {
    const hasImage = Boolean(imageFileFromDataTransfer(event.clipboardData));
    const handled = handle(event.clipboardData);
    if (hasImage || handled) event.preventDefault();
  };
  element.addEventListener('dragover', onDragOver);
  element.addEventListener('drop', onDrop);
  element.addEventListener('paste', onPaste);
  return () => {
    element.removeEventListener('dragover', onDragOver);
    element.removeEventListener('drop', onDrop);
    element.removeEventListener('paste', onPaste);
  };
}
