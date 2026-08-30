// ============================================================================
// silhouette.js
//   公式サイトのキャラクター画像を canvas に読み込み、
//     1. 前景マスクを作る (透過 PNG ならアルファ、白背景画像なら flood fill)
//     2. シルエットの輪郭を Moore 近傍追跡で抽出する
//     3. Ramer-Douglas-Peucker で頂点を間引き、Matter.js の当たり判定に使う
//   ことで「どうぶつタワーバトル」らしい引っ掛かりのある形を自動生成する。
//
//   画像 CDN (images.microcms-assets.io) は Access-Control-Allow-Origin: * を
//   返すため crossOrigin="anonymous" で読み込めば canvas は汚染されない。
// ============================================================================

const Silhouette = (() => {
  const SRC_H = 300;          // imgix に要求する読み込み解像度(高さ)
  const BG_LEVEL = 234;       // これ以上明るく
  const BG_CHROMA = 20;       // かつ彩度がこれ以下なら「白背景候補」
  const ALPHA_FG = 96;        // 透過画像のとき、これ以上のアルファを前景とみなす
  const MAX_VERTS = 44;       // Matter に渡す輪郭の最大頂点数

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像を読み込めませんでした: ' + src));
      img.src = src;
    });
  }

  // 画像の外周がすべて透明なら「アルファ付きの切り抜き済み画像」とみなす
  function hasTransparentBorder(data, w, h) {
    const opaque = (x, y) => data[(y * w + x) * 4 + 3] > 8;
    for (let x = 0; x < w; x++) if (opaque(x, 0) || opaque(x, h - 1)) return false;
    for (let y = 0; y < h; y++) if (opaque(0, y) || opaque(w - 1, y)) return false;
    return true;
  }

  // --- 外周から白を塗りつぶして背景マスクを作る -----------------------------
  function floodBackground(data, w, h) {
    const bg = new Uint8Array(w * h);
    const stack = [];
    const isWhitish = (i) => {
      const p = i * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
      if (a < 24) return true;                       // もともと透過している画像用
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return mn >= BG_LEVEL && mx - mn <= BG_CHROMA;
    };
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      if (bg[i] || !isWhitish(i)) return;
      bg[i] = 1;
      stack.push(i);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    return bg;
  }

  // --- 8 近傍で最大の連結成分だけ残す (小さなノイズを捨てる) ----------------
  function largestComponent(mask, w, h) {
    const label = new Int32Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    let best = -1, bestSize = 0;
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || label[s] >= 0) continue;
      let head = 0, tail = 0, size = 0;
      queue[tail++] = s; label[s] = s;
      while (head < tail) {
        const i = queue[head++]; size++;
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            if (mask[n] && label[n] < 0) { label[n] = s; queue[tail++] = n; }
          }
        }
      }
      if (size > bestSize) { bestSize = size; best = s; }
    }
    const out = new Uint8Array(w * h);
    if (best < 0) return { mask: out, size: 0 };
    for (let i = 0; i < w * h; i++) if (label[i] === best) out[i] = 1;
    return { mask: out, size: bestSize };
  }

  // 細い髪やしっぽが千切れないよう 1px 膨張 → 収縮 (クロージング)
  function close1(mask, w, h) {
    const dil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) dil[ny * w + nx] = 1;
          }
        }
      }
    }
    const ero = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!dil[y * w + x]) continue;
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !dil[ny * w + nx]) { all = 0; break; }
          }
        }
        ero[y * w + x] = all;
      }
    }
    return ero;
  }

  // --- Moore 近傍追跡で外周輪郭を得る ---------------------------------------
  const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]; // 時計回り
  function traceContour(mask, w, h) {
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : mask[y * w + x];
    let sx = -1, sy = -1;
    for (let y = 0; y < h && sx < 0; y++) {
      for (let x = 0; x < w; x++) if (mask[y * w + x]) { sx = x; sy = y; break; }
    }
    if (sx < 0) return [];
    const out = [[sx, sy]];
    let px = sx, py = sy, back = 4; // 直前に見た画素は西側にある
    const limit = w * h * 4;
    for (let step = 0; step < limit; step++) {
      let moved = false;
      for (let i = 1; i <= 8; i++) {
        const d = (back + i) % 8;
        const nx = px + N8[d][0], ny = py + N8[d][1];
        if (at(nx, ny)) {
          back = (d + 4) % 8;
          px = nx; py = ny; moved = true;
          break;
        }
      }
      if (!moved) break;
      if (px === sx && py === sy) break;
      out.push([px, py]);
    }
    return out;
  }

  // --- Ramer-Douglas-Peucker ------------------------------------------------
  function rdp(points, eps) {
    if (points.length < 3) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = points[a][0], ay = points[a][1];
      const bx = points[b][0], by = points[b][1];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      let far = -1, farD = eps;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
        if (d > farD) { farD = d; far = i; }
      }
      if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
    }
    return points.filter((_, i) => keep[i]);
  }

  // 閉曲線なので半周ずつ RDP をかけ、頂点数が収まるまで許容誤差を上げる
  function simplifyClosed(points, startEps) {
    let eps = startEps;
    for (let attempt = 0; attempt < 10; attempt++) {
      const half = points.length >> 1;
      const a = rdp(points.slice(0, half + 1), eps);
      const b = rdp(points.slice(half), eps);
      const merged = a.slice(0, -1).concat(b.slice(0, -1));
      if (merged.length <= MAX_VERTS) return merged;
      eps *= 1.4;
    }
    return rdp(points, eps).slice(0, MAX_VERTS);
  }

  function signedArea(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      const p = v[i], q = v[(i + 1) % v.length];
      s += p.x * q.y - q.x * p.y;
    }
    return s / 2;
  }

  // --- 段階的に縮小して縮小時のジャギーを抑える -----------------------------
  function downscale(src, dw, dh) {
    let cur = src;
    while (cur.width / 2 > dw && cur.height / 2 > dh) {
      const next = document.createElement('canvas');
      next.width = Math.max(1, cur.width >> 1);
      next.height = Math.max(1, cur.height >> 1);
      const c = next.getContext('2d');
      c.imageSmoothingQuality = 'high';
      c.drawImage(cur, 0, 0, next.width, next.height);
      cur = next;
    }
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(dw));
    out.height = Math.max(1, Math.round(dh));
    const c = out.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, out.width, out.height);
    return out;
  }

  /**
   * キャラクター画像からスプライトと当たり判定用ポリゴンを作る。
   * @param {{id:string,name:string,url:string}} ch
   * @param {number} targetH  完成スプライトの高さ(px)
   */
  async function build(ch, targetH) {
    const img = await loadImage(characterImageUrl(ch, SRC_H));
    const w = img.naturalWidth || SRC_H;
    const h = img.naturalHeight || SRC_H;

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);

    let image;
    try {
      image = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      throw new Error('canvas が汚染されました (CORS)。ローカルサーバー経由で開いてください。');
    }
    const data = image.data;

    // --- 前景マスク ---------------------------------------------------------
    // 立ち絵はアルファ付きで切り抜き済みなのでアルファをそのまま使う。
    // 白背景の画像が来た場合だけ、外周からの flood fill で背景を落とす。
    const cutout = hasTransparentBorder(data, w, h);
    let fg = new Uint8Array(w * h);
    if (cutout) {
      for (let i = 0; i < w * h; i++) fg[i] = data[i * 4 + 3] >= ALPHA_FG ? 1 : 0;
    } else {
      const bg = floodBackground(data, w, h);
      for (let i = 0; i < w * h; i++) fg[i] = bg[i] ? 0 : 1;
    }
    fg = close1(fg, w, h);
    fg = largestComponent(fg, w, h).mask;

    if (!cutout) {
      // 背景を透過に。輪郭付近の白いフリンジは明度に応じて薄くする
      for (let i = 0; i < w * h; i++) {
        const p = i * 4;
        if (!fg[i]) { data[p + 3] = 0; continue; }
        const x = i % w, y = (i / w) | 0;
        let edge = false;
        for (let d = 0; d < 4 && !edge; d++) {
          const nx = x + [1, -1, 0, 0][d], ny = y + [0, 0, 1, -1][d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !fg[ny * w + nx]) edge = true;
        }
        if (edge) {
          const mn = Math.min(data[p], data[p + 1], data[p + 2]);
          if (mn > 200) data[p + 3] = Math.round(255 * (1 - (mn - 200) / 55));
        }
      }
      ctx.putImageData(image, 0, 0);
    }

    // 見えている画素のバウンディングボックス。
    // 当たり判定から外れた細い毛先なども絵としては残すので、マスクではなくアルファで測る。
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] < 16 && !fg[y * w + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) throw new Error('シルエットを抽出できませんでした: ' + ch.id);
    const bw = maxX - minX + 1, bh = maxY - minY + 1;

    const scale = targetH / bh;
    const outW = Math.round(bw * scale), outH = Math.round(bh * scale);

    const trimmed = document.createElement('canvas');
    trimmed.width = bw; trimmed.height = bh;
    trimmed.getContext('2d').drawImage(cv, minX, minY, bw, bh, 0, 0, bw, bh);
    const sprite = downscale(trimmed, outW, outH);

    const contour = traceContour(fg, w, h);
    const verts = simplifyClosed(contour, 1.6)
      .map(([x, y]) => ({ x: (x - minX) * scale, y: (y - minY) * scale }));

    // Matter.js は時計回り (y 下向き) を期待するので向きを揃える
    if (signedArea(verts) < 0) verts.reverse();

    return { sprite, verts, width: outW, height: outH, char: ch };
  }

  return { build, loadImage };
})();
