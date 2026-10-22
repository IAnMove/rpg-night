import type { Session } from '../shared/types.js';
import { t } from './i18n.js';

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean).flatMap(word => {
    const pieces: string[] = []; let piece = '';
    for (const char of word) {
      if (piece && ctx.measureText(piece + char).width > maxWidth) { pieces.push(piece); piece = char; }
      else piece += char;
    }
    if (piece) pieces.push(piece); return pieces;
  });
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

/** Rasterize the self-contained public-history SVG, with a bounded canvas for long stories. */
export async function exportSvgPng(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = await loadImage(url);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error('The comic has no image dimensions.');
    const scale = Math.min(1, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image export is unavailable.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image export failed.')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Client-side comic PNG from session scenes (same-origin imageUrl SVG/PNG),
 * with titles and wrapped captions, without a server-side graphics dependency.
 */
export async function exportComicPng(session: Session): Promise<Blob> {
  const panelW = 720;
  const imgH = 400;
  const pad = 28;
  const gap = 24;
  const cols = 2;
  const headerH = 150;
  const footerH = 48;
  const maxTextW = panelW - 48;

  const images = await Promise.all(
    session.scenes.map(scene => loadImage(scene.imageUrl)),
  );

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('Canvas unavailable');

  type Measured = {
    scene: (typeof session.scenes)[number];
    image: HTMLImageElement;
    titleLines: string[];
    actionLines: string[];
    captionLines: string[];
    height: number;
  };

  const panels: Measured[] = session.scenes.map((scene, i) => {
    measure.font = '28px Georgia, serif';
    const titleLines = wrapLines(measure, scene.title, maxTextW);
    measure.font = '16px system-ui, sans-serif';
    const actionLines = scene.action
      ? wrapLines(measure, `${t(session.language, 'choicePrefix')} · ${scene.action}`, maxTextW)
      : [];
    measure.font = '17px system-ui, sans-serif';
    const captionLines = wrapLines(measure, scene.narration, maxTextW);
    const textH =
      24 +
      titleLines.length * 34 +
      (actionLines.length ? 10 + actionLines.length * 22 : 0) +
      12 +
      captionLines.length * 24 +
      20;
    return {
      scene,
      image: images[i]!,
      titleLines,
      actionLines,
      captionLines,
      height: imgH + textH,
    };
  });

  const rows: Measured[][] = [];
  for (let i = 0; i < panels.length; i += cols) rows.push(panels.slice(i, i + cols));
  let bodyH = 0;
  for (const row of rows) {
    bodyH += Math.max(...row.map(p => p.height)) + gap;
  }

  const canvasW = pad * 2 + cols * panelW + gap;
  const canvasH = headerH + bodyH + footerH;
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  ctx.fillStyle = '#0b1420';
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.fillStyle = '#edcb89';
  ctx.font = '16px system-ui, sans-serif';
  const banner = session.language === 'es' ? 'RPG NIGHT · VUESTRA HISTORIA' : 'RPG NIGHT · YOUR STORY, TOGETHER';
  ctx.fillText(banner, pad, 40);

  ctx.fillStyle = '#f3e9d5';
  ctx.font = '36px Georgia, serif';
  const titleWrapped = wrapLines(ctx, session.title, canvasW - pad * 2);
  titleWrapped.forEach((line, i) => ctx.fillText(line, pad, 88 + i * 40));

  ctx.fillStyle = '#9babba';
  ctx.font = '17px system-ui, sans-serif';
  const meta = `${session.players.join(' · ')} · ${session.provider === 'demo' ? 'Demo' : 'Amazon Bedrock'}`;
  ctx.fillText(meta, pad, 88 + titleWrapped.length * 40 + 12);

  let y = headerH;
  for (const row of rows) {
    const rowH = Math.max(...row.map(p => p.height));
    row.forEach((p, col) => {
      const x = pad + col * (panelW + gap);
      ctx.fillStyle = '#14212d';
      roundRect(ctx, x, y, panelW, p.height, 10);
      ctx.fill();
      ctx.strokeStyle = '#34414b';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.save();
      roundRect(ctx, x + 1, y + 1, panelW - 2, imgH - 2, 8);
      ctx.clip();
      drawCover(ctx, p.image, x + 1, y + 1, panelW - 2, imgH - 2);
      ctx.restore();

      ctx.fillStyle = '#0b1420';
      roundRect(ctx, x + 16, y + 16, 40, 28, 6);
      ctx.fill();
      ctx.fillStyle = '#edcb89';
      ctx.font = '16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(p.scene.number), x + 36, y + 36);
      ctx.textAlign = 'left';

      let ty = y + imgH + 28;
      ctx.fillStyle = '#f3e9d5';
      ctx.font = '28px Georgia, serif';
      for (const line of p.titleLines) {
        ctx.fillText(line, x + 24, ty);
        ty += 34;
      }
      if (p.actionLines.length) {
        ty += 6;
        ctx.fillStyle = '#ddbc7e';
        ctx.font = '16px system-ui, sans-serif';
        for (const line of p.actionLines) {
          ctx.fillText(line, x + 24, ty);
          ty += 22;
        }
      }
      ty += 10;
      ctx.fillStyle = '#bdc8cd';
      ctx.font = '17px system-ui, sans-serif';
      for (const line of p.captionLines) {
        ctx.fillText(line, x + 24, ty);
        ty += 24;
      }
    });
    y += rowH + gap;
  }

  ctx.fillStyle = '#91a4b5';
  ctx.font = '15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const footer = session.language === 'es'
    ? 'Cada decisión, una historia que recordar.'
    : 'Every choice, a story worth keeping.';
  ctx.fillText(footer, canvasW / 2, canvasH - 20);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('PNG encode failed'));
    }, 'image/png');
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number, y: number, w: number, h: number,
): void {
  const ir = img.naturalWidth / img.naturalHeight;
  const tr = w / h;
  let dw = w;
  let dh = h;
  let dx = x;
  let dy = y;
  if (ir > tr) {
    dw = h * ir;
    dx = x + (w - dw) / 2;
  } else {
    dh = w / ir;
    dy = y + (h - dh) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
