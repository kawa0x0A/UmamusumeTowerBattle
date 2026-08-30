// ============================================================================
// ウマ娘タワーバトル
//   「どうぶつタワーバトル」を参考にしたターン制の積み上げ対戦ゲーム。
//   ルール:
//     - 交互に 1 体ずつウマ娘を落として台座の上に積み上げる
//     - 自分が落としたことで誰かが芝生(地面)に落ちたら、落とした人の負け
//     - 制限時間 30 秒。時間切れになるとその位置で自動的に落ちる
// ============================================================================

(() => {
'use strict';

const { Engine, Composite, Bodies, Body, Vertices, Events, Common } = Matter;
if (window.decomp && Common.setDecomp) Common.setDecomp(window.decomp);

// ------------------------------- 定数 --------------------------------------
// ワールドは横 480 相当の広さを基準にし、実際に見える範囲は画面に合わせて伸縮する。
// 描画は「キャンバスいっぱい」に行い、レターボックスの余白は作らない。
const VIEW_W = 480;              // 画面幅いっぱいに見せるワールド幅
const MIN_VIEW_H = 520;          // これ以下に縦が潰れる場合だけ縮小する (芝生が見える下限)
const CX = 240;                  // ワールドの中心 x (台座の中心)
const TURF_MARGIN = 46;          // 画面下端に見せる芝生の厚み
const TOP_RATIO = 0.34;          // 塔のてっぺんを画面のどの高さに保つか
const GROUND_Y = 600;            // 台座の上面(ワールド座標)
const PEDESTAL_W = 232;
const PEDESTAL_H = 22;
const TURF_Y = 704;              // 芝生の上面 = ここに触れたら負け
const PIECE_H = 128;             // ウマ娘 1 体の高さ
const DROP_GAP = 34;             // 塔のてっぺんからどれくらい上に出現させるか
const TURN_TIME = 30;
// --- 静止判定 (緩めると、まだ動いているのに手番が回ってしまう) ---
const SETTLE_SPEED = 0.08;       // 1 ステップあたりの移動量 (約 5px/秒)
const SETTLE_SPIN = 0.004;       // 1 ステップあたりの回転量 (約 14度/秒)
const SETTLE_HOLD = 0.5;         // この秒数ぶん静止し続けたら手番交代
const SETTLE_RELAX_AFTER = 10;   // これを過ぎたら判定を緩める (細かい揺れで止まらない対策)
const SETTLE_FORCE_AFTER = 20;   // 最後の保険。ここまで来たら諦めて交代する
const PX_PER_CM = 2;             // 高さ表示用のスケール
const PRELOAD_FIRST = 12;        // タイトルで待つ体数
const ROSTER_SIZE = 30;          // 1 ゲームで使う体数 (毎回ランダムに選ぶ)

// 見えている範囲 (resize() で更新)。w/h はワールド単位、scale は px/ワールド単位。
const view = { scale: 1, w: VIEW_W, h: 760, anchor: 600, top: 260 };
let AIM_MIN = CX - 178, AIM_MAX = CX + 178;

// ------------------------------- DOM ---------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('field');
const ctx = canvas.getContext('2d');
const stageEl = $('stage');
const overlay = $('overlay');
const titlePanel = $('titlePanel');
const resultPanel = $('resultPanel');
const toastEl = $('toast');

// ------------------------------- 状態 --------------------------------------
const engine = Engine.create({ enableSleeping: true });
engine.gravity.y = 0.5;   // ふわっと落として積みやすくする
engine.positionIterations = 10;
engine.velocityIterations = 8;
engine.constraintIterations = 3;
const world = engine.world;

let pedestal = null, turf = null;
let placed = [];                 // 積まれたウマ娘の body
let shapes = [];                 // 読み込み済みのシルエット
let shapeIndex = new Map();      // id -> shape

const game = {
  state: 'title',                // title | aim | falling | over
  mode: 'cpu',
  difficulty: 'normal',
  current: 0,                    // 0 = P1, 1 = P2/CPU
  lastDropper: 0,
  held: null,                    // { body, shape, offset }
  aimX: CX,
  aimAngle: 0,
  timeLeft: TURN_TIME,
  settleTimer: 0,
  fallTimer: 0,
  lastShape: null,
  loser: -1,
  cpuTarget: null,
  cpuWait: 0,
  topY: GROUND_Y,                 // 手番開始時の塔のてっぺん
  spawnY: GROUND_Y - 150,
  height: 0,                      // 塔の高さ(cm)。落下中の値がブレないよう静止時に確定する
  net: 'none',                    // none | host | guest  (オンライン対戦の役割)
  netResult: null,                // ゲスト側の結果表示用 (ホストから届いた値)
};

let netIdSeq = 0;                // 積んだウマ娘に振る通し番号 (通信用)
let netTop = GROUND_Y;           // ゲスト側が持つ塔のてっぺん
const ghostById = new Map();     // ゲスト側: netId -> 描画用のニセ body

const cam = { y: GROUND_Y, target: GROUND_Y };
let renderScale = 1;

// ============================================================================
// ステージの構築
// ============================================================================
function buildStage() {
  Composite.clear(world, false);
  placed = [];
  pedestal = Bodies.rectangle(CX, GROUND_Y + PEDESTAL_H / 2, PEDESTAL_W, PEDESTAL_H, {
    isStatic: true, friction: 1, frictionStatic: 3, restitution: 0, label: 'pedestal',
  });
  // 芝生。ここに触れた時点で「落とした」と判定する
  turf = Bodies.rectangle(CX, TURF_Y + 200, 4000, 400, {
    isStatic: true, friction: 0.9, restitution: 0, label: 'turf',
  });
  Composite.add(world, [pedestal, turf]);
}

// ============================================================================
// ウマ娘 body の生成
// ============================================================================
function createBody(shape) {
  let body = null;
  try {
    body = Bodies.fromVertices(0, 0, [shape.verts], {
      friction: 1,
      frictionStatic: 3,
      frictionAir: 0.06,
      restitution: 0,
      density: 0.0014,
    }, true, 0.01, 8, 0.01);
  } catch (e) {
    body = null;
  }
  // 分解に失敗して破片だらけになった場合は凸包で近似する
  if (!body || body.parts.length > 18) {
    const hull = Vertices.hull(shape.verts.map((v) => ({ x: v.x, y: v.y })));
    body = Bodies.fromVertices(0, 0, [hull], {
      friction: 1, frictionStatic: 3, frictionAir: 0.06, restitution: 0, density: 0.0014,
    });
  }
  if (!body) {
    body = Bodies.rectangle(0, 0, shape.width * 0.7, shape.height, {
      friction: 1, frictionStatic: 3, frictionAir: 0.06, restitution: 0, density: 0.0014,
    });
  }

  // スプライトの原点(画像左上)が body ローカル座標のどこに来るかを求める
  let minX = Infinity, minY = Infinity;
  for (const v of shape.verts) { if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; }
  const offset = {
    x: -(minX - body.bounds.min.x),
    y: -(minY - body.bounds.min.y),
  };
  body.uma = { shape, offset };
  body.netId = ++netIdSeq;
  return body;
}

// ============================================================================
// ターン進行
// ============================================================================
function pickShape() {
  if (!shapes.length) return null;
  for (let i = 0; i < 8; i++) {
    const s = shapes[(Math.random() * shapes.length) | 0];
    if (s !== game.lastShape || shapes.length === 1) { game.lastShape = s; return s; }
  }
  return shapes[0];
}

function spawnPiece() {
  const shape = pickShape();
  if (!shape) return;
  const body = createBody(shape);
  game.held = body;
  game.topY = towerTop();
  game.aimX = clamp(CX + (Math.random() - 0.5) * 90, AIM_MIN, AIM_MAX);
  game.aimAngle = (Math.random() - 0.5) * 0.5;
  updateHeldPose();
  game.timeLeft = TURN_TIME;
  game.state = 'aim';
  game.cpuTarget = null;
  game.cpuWait = 0.55;
  $('pieceName').textContent = shape.char.name;
  updateHud();
  if (isCPU(game.current)) planCpuMove();
  if (game.net === 'host') {
    netSend({
      t: 'spawn', id: body.netId, ch: shape.char.id,
      ox: round2(body.uma.offset.x), oy: round2(body.uma.offset.y),
      cur: game.current, top: round2(game.topY),
      x: round2(game.aimX), a: round2(game.aimAngle),
    });
  }
}

// 回転させても塔のてっぺんからの隙間が一定になるように、下端を基準に配置する
function updateHeldPose() {
  const body = game.held;
  if (!body) return;
  Body.setAngle(body, game.aimAngle);
  Body.setPosition(body, { x: game.aimX, y: 0 });
  game.spawnY = game.topY - DROP_GAP - body.bounds.max.y;
  Body.setPosition(body, { x: game.aimX, y: game.spawnY });
}

function dropPiece() {
  if (game.state !== 'aim') return;
  // ゲストは自分で落とさず、ホストに「落として」と頼むだけ
  if (game.net === 'guest') { netSend({ t: 'drop' }); return; }
  if (!game.held) return;
  const body = game.held;
  updateHeldPose();
  Body.setVelocity(body, { x: 0, y: 0 });
  Body.setAngularVelocity(body, 0);
  Composite.add(world, body);
  placed.push(body);
  game.held = null;
  game.lastDropper = game.current;
  game.state = 'falling';
  game.settleTimer = 0;
  game.fallTimer = 0;
  updateHud();
  if (game.net === 'host') netSync(true);
}

function nextTurn() {
  // すべて静止した状態で高さを確定させる (空中のウマ娘を数えない)
  game.height = Math.max(0, Math.round((GROUND_Y - towerTop()) / PX_PER_CM));
  if (game.mode !== 'solo') {
    game.current = 1 - game.current;
    showToast(playerName(game.current) + ' のばん');
  }
  spawnPiece();
}

function isCPU(i) { return game.net === 'none' && game.mode === 'cpu' && i === 1; }

// オンライン対戦ではホストが 0、ゲストが 1
function myIndex() { return game.net === 'guest' ? 1 : 0; }

function playerName(i) {
  if (game.mode === 'solo') return 'あなた';
  if (isCPU(i)) return 'CPU';
  if (game.net !== 'none') return i === myIndex() ? 'あなた' : 'あいて';
  return 'プレイヤー' + (i + 1);
}

// スプライト座標の頂点をボディローカルに直したときの、回転後の下端
function rotatedBottom(shape, offset, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  let m = -Infinity;
  for (const v of shape.verts) {
    const y = (v.x + offset.x) * s + (v.y + offset.y) * c;
    if (y > m) m = y;
  }
  return m;
}

function round2(v) { return Math.round(v * 100) / 100; }

// ============================================================================
// 決着判定
// ============================================================================
Events.on(engine, 'collisionStart', (ev) => {
  if (game.state === 'over' || game.state === 'title') return;
  for (const pair of ev.pairs) {
    if (pair.bodyA === turf || pair.bodyB === turf) {
      const other = pair.bodyA === turf ? pair.bodyB : pair.bodyA;
      if (other === pedestal) continue;
      gameOver(game.lastDropper);
      return;
    }
  }
});

function gameOver(loserIndex) {
  if (game.state === 'over') return;
  game.state = 'over';
  game.loser = loserIndex;
  if (game.net === 'host') {
    netSync(true);
    netSend({ t: 'over', loser: loserIndex, n: placed.length, h: game.height });
  }
  setTimeout(showResult, 900);
}

// ============================================================================
// メインループ
// ============================================================================
let lastTime = performance.now();

function tick(dt) {
  if (game.state !== 'title') {
    if (game.net === 'guest') {
      stepGuest(dt);                      // ゲストは物理を回さず、届いた座標を描くだけ
    } else {
      Engine.update(engine, Math.min(1000 / 60, dt * 1000));
      step(dt);
    }
  }
  render();
}

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 1 / 20);
  lastTime = now;
  tick(dt);
  requestAnimationFrame(loop);
}

function step(dt) {
  // --- カメラ ---
  cam.target = Math.min(GROUND_Y, towerTop() + (view.anchor - view.top));
  cam.y += (cam.target - cam.y) * Math.min(1, dt * 5);

  // --- 落下中 → 静止判定 ---
  if (game.state === 'falling') {
    game.fallTimer += dt;
    if (isSettled(game.fallTimer > SETTLE_RELAX_AFTER)) {
      game.settleTimer += dt;
      if (game.settleTimer > SETTLE_HOLD) nextTurn();
    } else {
      game.settleTimer = 0;
    }
    if (game.fallTimer > SETTLE_FORCE_AFTER) nextTurn();
    // 場外に飛んでいったものも負けにする
    for (const b of placed) {
      if (b.position.y > TURF_Y + 400 || Math.abs(b.position.x - CX) > 1400) {
        gameOver(game.lastDropper);
        break;
      }
    }
  }

  // --- 操作待ち ---
  if (game.state === 'aim') {
    if (isCPU(game.current)) {
      stepCpu(dt);
    } else {
      if (humanTurn()) stepKeys(dt);      // 相手の番にこちらのキーで動かさない
      game.timeLeft -= dt;
      if (game.timeLeft <= 0) { game.timeLeft = 0; showToast('じかんぎれ！'); dropPiece(); }
    }
    updateHeldPose();
    updateTimer();
  }

  if (game.net === 'host') netHostTick(dt);
}

// relaxed: 長引いたときだけ判定を緩める。
// 落下中のウマ娘を「静止」と誤判定しないよう、通常の閾値はかなり厳しめにしてある。
function isSettled(relaxed) {
  const maxSpeed = relaxed ? 0.3 : SETTLE_SPEED;
  const maxSpin = relaxed ? 0.02 : SETTLE_SPIN;
  for (const b of placed) {
    if (b.isSleeping) continue;
    if (b.speed > maxSpeed || b.angularSpeed > maxSpin) return false;
  }
  return true;
}

function towerTop() {
  if (game.net === 'guest') return netTop;
  let top = GROUND_Y;
  for (const b of placed) if (b.bounds.min.y < top) top = b.bounds.min.y;
  return top;
}

// ============================================================================
// 描画
// ============================================================================
function render() {
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);

  drawSky();

  ctx.save();
  ctx.translate(view.w / 2 - CX, view.anchor - cam.y);

  drawHeightLines();
  drawTurf();
  drawPedestal();
  for (const b of placed) drawBody(b, 1);
  if (game.held) { drawGuide(); drawBody(game.held, 0.82); }

  ctx.restore();
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, view.h);
  g.addColorStop(0, '#a8dcf5');
  g.addColorStop(.55, '#cfeaf8');
  g.addColorStop(1, '#e9f6df');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.w, view.h);

  // ゆるい雲(カメラに合わせて視差スクロール)
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  const off = (GROUND_Y - cam.y) * 0.25;
  for (let i = 0; i < 6; i++) {
    const cx = ((i * 137) % (view.w + 160)) - 80;
    const cy = ((i * 211 + off) % (view.h + 200)) - 100;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 52, 20, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 34, cy + 6, 34, 15, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHeightLines() {
  const topWorld = cam.y - view.anchor;
  const left = CX - view.w / 2, right = CX + view.w / 2;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  for (let y = GROUND_Y - 100; y > topWorld - 100; y -= 100) {
    ctx.strokeStyle = 'rgba(255,255,255,.6)';
    ctx.beginPath();
    ctx.moveTo(left, y); ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(43,36,64,.28)';
    ctx.fillText(Math.round((GROUND_Y - y) / PX_PER_CM) + 'cm', left + 8, y - 3);
  }
  ctx.restore();
}

function drawTurf() {
  const left = CX - view.w / 2 - 20, w = view.w + 40;
  ctx.fillStyle = '#6fc36b';
  ctx.fillRect(left, TURF_Y, w, 400);
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  for (let x = left; x < left + w; x += 44) ctx.fillRect(x, TURF_Y, 22, 400);
  ctx.fillStyle = '#5aa957';
  ctx.fillRect(left, TURF_Y, w, 5);
}

function drawPedestal() {
  // 支柱
  ctx.fillStyle = '#b9a68f';
  ctx.fillRect(CX - 15, GROUND_Y + PEDESTAL_H, 30, TURF_Y - GROUND_Y - PEDESTAL_H);
  ctx.fillStyle = 'rgba(0,0,0,.12)';
  ctx.fillRect(CX + 5, GROUND_Y + PEDESTAL_H, 10, TURF_Y - GROUND_Y - PEDESTAL_H);
  // 台座
  roundRect(CX - PEDESTAL_W / 2, GROUND_Y, PEDESTAL_W, PEDESTAL_H, 5);
  ctx.fillStyle = '#8c7a63';
  ctx.fill();
  roundRect(CX - PEDESTAL_W / 2, GROUND_Y, PEDESTAL_W, 7, 4);
  ctx.fillStyle = '#a8987f';
  ctx.fill();
}

function drawBody(body, alpha) {
  const { shape, offset } = body.uma;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);
  ctx.drawImage(shape.sprite, offset.x, offset.y, shape.width, shape.height);
  ctx.restore();
}

function drawGuide() {
  ctx.save();
  ctx.strokeStyle = game.current === 0 ? 'rgba(255,91,147,.5)' : 'rgba(74,168,255,.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  const held = game.held;
  const bottom = held.bounds
    ? held.bounds.max.y
    : held.position.y + rotatedBottom(held.uma.shape, held.uma.offset, held.angle);
  ctx.moveTo(held.position.x, bottom + 4);
  ctx.lineTo(held.position.x, Math.min(GROUND_Y, towerTop() + 12));
  ctx.stroke();
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============================================================================
// CPU
// ============================================================================
const DIFF = {
  easy:   { xNoise: 46, aNoise: 0.45, samples: 14 },
  normal: { xNoise: 18, aNoise: 0.18, samples: 26 },
  hard:   { xNoise: 6,  aNoise: 0.06, samples: 40 },
};

// 与えられた x 座標での「積まれているものの上面」を返す (無ければ Infinity)
function surfaceAt(x) {
  let best = Infinity;
  for (const b of placed) {
    if (x >= b.bounds.min.x && x <= b.bounds.max.x && b.bounds.min.y < best) best = b.bounds.min.y;
  }
  if (Math.abs(x - CX) <= PEDESTAL_W / 2 && GROUND_Y < best) best = GROUND_Y;
  return best;
}

function towerCenterX() {
  if (!placed.length) return CX;
  let sx = 0, sm = 0;
  for (const b of placed) { sx += b.position.x * b.mass; sm += b.mass; }
  return sm ? sx / sm : CX;
}

// 回転後のバウンディングボックスを見積もる
function rotatedBox(verts, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of verts) {
    const x = v.x * c - v.y * s, y = v.x * s + v.y * c;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { w: maxX - minX, h: maxY - minY };
}

function planCpuMove() {
  const d = DIFF[game.difficulty] || DIFF.normal;
  const shape = game.held.uma.shape;
  const comX = towerCenterX();

  // --- 角度: 幅が広く背が低い置き方ほど安定 ---
  let bestAngle = 0, bestAngleScore = -Infinity;
  for (let a = -1.4; a <= 1.4001; a += 0.35) {
    const box = rotatedBox(shape.verts, a);
    const sc = box.w * 0.8 - box.h * 0.55 - Math.abs(a) * 3 + Math.random() * 6;
    if (sc > bestAngleScore) { bestAngleScore = sc; bestAngle = a; }
  }
  const angle = bestAngle + (Math.random() - 0.5) * d.aNoise;
  const box = rotatedBox(shape.verts, angle);
  const halfW = Math.max(12, box.w / 2 - 4);

  // --- 位置: 平らで、塔の重心に近く、なるべく低い所を選ぶ ---
  let bestX = CX, bestScore = -Infinity;
  const lo = Math.max(AIM_MIN, comX - 110), hi = Math.min(AIM_MAX, comX + 110);
  for (let i = 0; i < d.samples; i++) {
    const cx = lo + (hi - lo) * (i / Math.max(1, d.samples - 1));
    const ys = [];
    for (let k = -3; k <= 3; k++) ys.push(surfaceAt(cx + (halfW * k) / 3));
    const finite = ys.filter((v) => isFinite(v));
    if (!finite.length) continue;
    const minY = Math.min(...finite), maxY = Math.max(...finite);
    const missing = ys.length - finite.length;             // 宙に浮く割合
    const score =
      -(maxY - minY) * 1.1                                  // 平らな所が良い
      - Math.abs(cx - comX) * 0.55                          // 重心の真上が良い
      + minY * 0.22                                         // 低い(=谷を埋める)方が良い
      - missing * 26
      + (Math.random() - 0.5) * d.xNoise;
    if (score > bestScore) { bestScore = score; bestX = cx; }
  }

  game.cpuTarget = {
    x: clamp(bestX + (Math.random() - 0.5) * d.xNoise * 0.5, AIM_MIN, AIM_MAX),
    angle,
  };
}

function stepCpu(dt) {
  if (!game.cpuTarget) return;
  game.cpuWait -= dt;
  if (game.cpuWait > 0) return;
  const t = game.cpuTarget;
  game.aimX += (t.x - game.aimX) * Math.min(1, dt * 6);
  game.aimAngle += (t.angle - game.aimAngle) * Math.min(1, dt * 6);
  if (Math.abs(t.x - game.aimX) < 1.2 && Math.abs(t.angle - game.aimAngle) < 0.02) {
    game.aimX = t.x; game.aimAngle = t.angle;
    dropPiece();
  }
}

// ============================================================================
// オンライン対戦 (ホスト権威)
//   ホスト: 物理を回し、全ウマ娘の座標を 15Hz でゲストに配る。
//   ゲスト: 届いた座標を補間して描くだけ。自分の手番の狙いだけホストに送る。
//           自分の持ちウマ娘は手元で先に動かす(クライアント予測)ので遅延を感じない。
// ============================================================================
let netRoster = [];              // ホストがその回に使うキャラ id
let netAccum = 0;                // 送信間隔用
let netInputAccum = 0;
let netLastX = null, netLastA = null;

function netSend(msg) { if (game.net !== 'none') Net.send(msg); }

function shortestAngle(d) {
  return ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

// --- ホスト側 ---------------------------------------------------------------
function netHostTick(dt) {
  netAccum += dt;
  if (netAccum >= 1 / 15) { netAccum = 0; netSync(); }
}

function netSync() {
  if (game.net !== 'host' || !Net.isOpen()) return;
  const b = [];
  for (const body of placed) {
    b.push([body.netId, round2(body.position.x), round2(body.position.y), round2(body.angle)]);
  }
  const h = game.held
    ? [round2(game.held.position.x), round2(game.held.position.y), round2(game.held.angle)]
    : 0;
  netSend({ t: 's', st: game.state, cur: game.current, top: round2(towerTop()),
            tl: round2(game.timeLeft), hh: game.height, h, b });
}

// --- ゲスト側 ---------------------------------------------------------------
function netGuestReset() {
  game.mode = 'vs';
  game.height = 0;
  placed = [];
  ghostById.clear();
  game.held = null;
  game.loser = -1;
  game.netResult = null;
  game.current = 0;
  game.state = 'falling';        // 最初の spawn が来るまでの待ち状態
  netTop = GROUND_Y;
  cam.y = cam.target = GROUND_Y;
  resultPanel.hidden = true;
  titlePanel.hidden = false;
  overlay.classList.remove('show');
  updateHud();
}

function makeGhost(id, charId, ox, oy) {
  const shape = shapeIndex.get(charId) || shapes[0];
  if (!shape) return null;
  const g = {
    netId: id, onTower: false,
    position: { x: CX, y: GROUND_Y - 200 }, angle: 0,
    tx: CX, ty: GROUND_Y - 200, ta: 0,
    uma: { shape, offset: { x: ox, y: oy } },
  };
  ghostById.set(id, g);
  return g;
}

function lerpGhost(g, k) {
  g.position.x += (g.tx - g.position.x) * k;
  g.position.y += (g.ty - g.position.y) * k;
  g.angle += shortestAngle(g.ta - g.angle) * k;
}

// ゲストが自分の持ちウマ娘を置く位置。ホストの updateHeldPose と同じ式。
function guestHeldPose() {
  const g = game.held;
  if (!g) return;
  g.angle = game.aimAngle;
  g.position.x = game.aimX;
  g.position.y = game.topY - DROP_GAP - rotatedBottom(g.uma.shape, g.uma.offset, g.angle);
  g.tx = g.position.x; g.ty = g.position.y; g.ta = g.angle;
}

function stepGuest(dt) {
  const k = 1 - Math.exp(-dt * 20);
  for (const g of placed) lerpGhost(g, k);

  cam.target = Math.min(GROUND_Y, towerTop() + (view.anchor - view.top));
  cam.y += (cam.target - cam.y) * Math.min(1, dt * 5);

  if (game.state === 'aim' && humanTurn()) {
    stepKeys(dt);
    guestHeldPose();
    netGuestSendInput(dt);
  } else if (game.held) {
    lerpGhost(game.held, k);
  }
  if (game.state === 'aim') {
    game.timeLeft = Math.max(0, game.timeLeft - dt);
    updateTimer();
  }
}

function netGuestSendInput(dt) {
  netInputAccum += dt;
  if (netInputAccum < 1 / 20) return;
  netInputAccum = 0;
  if (game.aimX === netLastX && game.aimAngle === netLastA) return;
  netLastX = game.aimX; netLastA = game.aimAngle;
  netSend({ t: 'i', x: round2(game.aimX), a: round2(game.aimAngle) });
}

function netApplySync(m) {
  netTop = m.top;
  if (m.cur !== game.current) {
    game.current = m.cur;
    showToast(playerName(m.cur) + ' のばん');
    netLastX = netLastA = null;
  }
  game.state = m.st;
  game.height = m.hh;
  if (!humanTurn()) game.timeLeft = m.tl;

  for (const row of m.b) {
    const g = ghostById.get(row[0]);
    if (!g) continue;
    g.tx = row[1]; g.ty = row[2]; g.ta = row[3];
    if (!g.onTower) {
      g.onTower = true;
      if (game.held === g) game.held = null;
      else { g.position.x = row[1]; g.position.y = row[2]; g.angle = row[3]; }
      placed.push(g);
    }
  }
  if (m.h && game.held && !humanTurn()) {
    game.held.tx = m.h[0]; game.held.ty = m.h[1]; game.held.ta = m.h[2];
  }
  updateHud();
}

// --- 受信 -------------------------------------------------------------------
function onNetMessage(m) {
  switch (m.t) {
    // ---- ゲストが受け取るもの ----
    case 'hello':
      netGuestPrepare(m.roster || []);
      break;
    case 'reset':
      netGuestReset();
      break;
    case 'spawn': {
      const g = makeGhost(m.id, m.ch, m.ox, m.oy);
      if (!g) break;
      game.held = g;
      game.topY = m.top;
      game.current = m.cur;
      game.aimX = m.x;
      game.aimAngle = m.a;
      game.timeLeft = TURN_TIME;
      game.state = 'aim';
      g.position.x = g.tx = m.x;
      g.angle = g.ta = m.a;
      g.position.y = g.ty = m.top - DROP_GAP - rotatedBottom(g.uma.shape, g.uma.offset, m.a);
      const ch = CHARACTERS.find((c) => c.id === m.ch);
      $('pieceName').textContent = ch ? ch.name : g.uma.shape.char.name;
      updateHud();
      break;
    }
    case 's':
      netApplySync(m);
      break;
    case 'over':
      game.state = 'over';
      game.loser = m.loser;
      game.netResult = { count: m.n, height: m.h };
      game.height = m.h;
      setTimeout(showResult, 900);
      break;

    // ---- ホストが受け取るもの ----
    case 'ready':
      if (game.net === 'host') startGame('vs');
      break;
    case 'i':
      if (game.net === 'host' && game.state === 'aim' && game.current === 1) {
        game.aimX = clamp(m.x, AIM_MIN, AIM_MAX);
        game.aimAngle = m.a;
      }
      break;
    case 'drop':
      if (game.net === 'host' && game.state === 'aim' && game.current === 1) dropPiece();
      break;
    case 'rematch':
      if (game.net === 'host' && game.state === 'over') startGame('vs');
      break;

    // ---- 双方 ----
    case 'bye':
      returnToTitle('あいてが退出しました。');
      break;
    default:
      break;
  }
}

// ゲスト: ホストが使うキャラを読み込んでから ready を返す
async function netGuestPrepare(roster) {
  const list = roster.map((id) => CHARACTERS.find((c) => c.id === id)).filter(Boolean);
  const need = list.filter((c) => !shapeIndex.has(c.id));
  if (need.length) {
    setStatus('joinStatus', 'ウマ娘を読み込み中… 0 / ' + need.length);
    await loadShapes(need, (d, t) => setStatus('joinStatus', 'ウマ娘を読み込み中… ' + d + ' / ' + t));
  }
  if (game.net !== 'guest') return;
  setStatus('joinStatus', 'まもなく開始します…');
  netGuestReset();
  netSend({ t: 'ready' });
}

function netLeave() {
  if (Net.isOpen()) netSend({ t: 'bye' });
  Net.close();
  game.net = 'none';
}

function returnToTitle(message) {
  Net.close();
  game.net = 'none';
  game.state = 'title';
  resultPanel.hidden = true;
  titlePanel.hidden = false;
  showStep(message ? 'vs' : 'mode');
  overlay.classList.add('show');
  if (message) setStatus('onlineNote', message, true);
}

// ============================================================================
// 入力
// ============================================================================
const keys = new Set();
let dragging = false, dragStartY = 0, dragStartAngle = 0;

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / r.width * view.w + (CX - view.w / 2),
    y: e.clientY - r.top,          // 回転量は画面 px 基準 (端末で感度を揃えるため)
  };
}

function humanTurn() {
  if (game.state !== 'aim') return false;
  if (isCPU(game.current)) return false;
  if (game.net !== 'none') return game.current === myIndex();
  return true;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!humanTurn()) return;
  canvas.setPointerCapture(e.pointerId);
  dragging = true;
  const p = canvasPoint(e);
  dragStartY = p.y;
  dragStartAngle = game.aimAngle;
  game.aimX = clamp(p.x, AIM_MIN, AIM_MAX);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !humanTurn()) return;
  const p = canvasPoint(e);
  game.aimX = clamp(p.x, AIM_MIN, AIM_MAX);
  game.aimAngle = dragStartAngle + (p.y - dragStartY) * 0.010;
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (humanTurn()) dropPiece();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { dragging = false; });

window.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
  if (e.repeat) return;
  if (e.key === ' ' || e.key === 'Enter') { if (humanTurn()) dropPiece(); return; }
  keys.add(e.key);
});
window.addEventListener('keyup', (e) => keys.delete(e.key));

function stepKeys(dt) {
  const move = 165 * dt, rot = 2.1 * dt;
  if (keys.has('ArrowLeft') || keys.has('a')) game.aimX -= move;
  if (keys.has('ArrowRight') || keys.has('d')) game.aimX += move;
  if (keys.has('ArrowUp') || keys.has('w')) game.aimAngle -= rot;
  if (keys.has('ArrowDown') || keys.has('s')) game.aimAngle += rot;
  game.aimX = clamp(game.aimX, AIM_MIN, AIM_MAX);
}

// 画面下のボタン(押しっぱなしで回り続ける)
function holdButton(el, fn) {
  let raf = 0, active = false;
  const tick = () => { if (!active) return; fn(); raf = requestAnimationFrame(tick); };
  const start = (e) => { e.preventDefault(); if (!humanTurn()) return; active = true; tick(); };
  const stop = () => { active = false; cancelAnimationFrame(raf); };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointercancel', stop);
}
holdButton($('btnRotL'), () => { game.aimAngle -= 0.035; });
holdButton($('btnRotR'), () => { game.aimAngle += 0.035; });
$('btnDrop').addEventListener('click', () => { if (humanTurn()) dropPiece(); });

// ============================================================================
// HUD
// ============================================================================
function updateHud() {
  const badge = $('turnBadge');
  badge.textContent = game.mode === 'solo' ? '★' : 'P' + (game.current + 1);
  badge.classList.toggle('p2', game.current === 1);
  $('turnName').textContent = playerName(game.current);
  $('statCount').textContent = placed.length;
  $('statHeight').textContent = game.height;
  const drop = $('btnDrop');
  drop.classList.toggle('p2', game.current === 1);
  drop.disabled = !humanTurn();
  $('btnRotL').disabled = drop.disabled;
  $('btnRotR').disabled = drop.disabled;
}

function updateTimer() {
  const fill = $('timerFill');
  const ratio = isCPU(game.current) ? 1 : Math.max(0, game.timeLeft / TURN_TIME);
  fill.style.width = (ratio * 100) + '%';
  fill.className = ratio < .2 ? 'danger' : ratio < .45 ? 'warn' : '';
  $('timerText').textContent = isCPU(game.current) ? '–' : Math.ceil(game.timeLeft);
  $('statCount').textContent = placed.length;
  $('statHeight').textContent = game.height;
}

let toastTimer = 0;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1100);
}

// ============================================================================
// 結果表示
// ============================================================================
function showResult() {
  const count = game.netResult ? game.netResult.count : placed.length;
  const height = game.height;
  $('resultCount').textContent = count;
  $('resultHeight').textContent = height;

  if (game.mode === 'solo') {
    $('resultTitle').textContent = 'おしまい';
    $('resultText').textContent = count + ' 段まで積めました。';
  } else {
    const winner = 1 - game.loser;
    $('resultTitle').textContent = playerName(winner) + ' のかち！';
    $('resultText').textContent = playerName(game.loser) + ' が落としてしまいました。';
  }

  // 最後に落としたウマ娘を結果画面に表示
  const face = $('resultFace');
  const fctx = face.getContext('2d');
  fctx.clearRect(0, 0, face.width, face.height);
  const last = placed[placed.length - 1];
  if (last) {
    const sp = last.uma.shape.sprite;
    const s = Math.min(face.width / sp.width, face.height / sp.height);
    fctx.drawImage(sp, (face.width - sp.width * s) / 2, (face.height - sp.height * s) / 2,
      sp.width * s, sp.height * s);
  }

  titlePanel.hidden = true;
  resultPanel.hidden = false;
  overlay.classList.add('show');
}

// ============================================================================
// 画像の読み込み
// ============================================================================
async function loadShapes(list, onProgress) {
  let done = 0;
  const conc = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const ch = list[cursor++];
      try {
        if (!shapeIndex.has(ch.id)) {
          const shape = await Silhouette.build(ch, PIECE_H);
          shapeIndex.set(ch.id, shape);
          shapes.push(shape);
        }
      } catch (err) {
        console.warn('スキップ:', ch.id, err.message);
      }
      done++;
      onProgress && onProgress(done, list.length);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function boot() {
  // 全 171 体を毎回読むと重いので、その回に使う分だけランダムに選ぶ
  const order = shuffled(CHARACTERS).slice(0, ROSTER_SIZE);
  netRoster = order.map((c) => c.id);
  const first = order.slice(0, PRELOAD_FIRST);
  const rest = order.slice(PRELOAD_FIRST);

  await loadShapes(first, (d, t) => {
    $('loadFill').style.width = (d / t * 100) + '%';
    $('loadText').textContent = `ウマ娘を読み込み中… ${d} / ${t}`;
  });

  if (!shapes.length) {
    $('loadText').innerHTML =
      'キャラクター画像を読み込めませんでした。<br>ネット接続を確認するか、ローカルサーバー経由で開いてください。';
    return;
  }

  $('loadingBox').style.display = 'none';
  document.querySelectorAll('.mode[data-mode]').forEach((b) => { b.disabled = false; });

  // 残りは遊びながら裏で読み込む
  loadShapes(rest);
}

// ============================================================================
// ゲーム開始 / リセット
// ============================================================================
function startGame(mode) {
  game.mode = mode;
  game.current = 0;
  game.lastDropper = 0;
  game.loser = -1;
  game.held = null;
  game.lastShape = null;
  cam.y = cam.target = GROUND_Y;
  game.netResult = null;
  game.height = 0;
  if (game.net === 'host') netSend({ t: 'reset' });
  buildStage();
  overlay.classList.remove('show');
  spawnPiece();
  showToast(mode === 'solo' ? 'スタート！' : playerName(0) + ' のばん');
}

// タイトルは複数ページ構成。mode -> (diff | vs -> host/join)
const STEPS = { mode: 'modeStep', diff: 'diffStep', vs: 'vsStep', host: 'hostStep', join: 'joinStep' };

function setStatus(id, text, isError) {
  const el = $(id);
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function refreshOnlineNote() {
  const ok = Net.available();
  $('btnHost').disabled = !ok;
  $('btnJoin').disabled = !ok;
  setStatus('onlineNote', ok ? '' : Net.unavailableReason(), true);
}

function showStep(name) {
  for (const key of Object.keys(STEPS)) $(STEPS[key]).hidden = (key !== name);
  if (name === 'diff') {
    document.querySelectorAll('.mode[data-diff]').forEach((b) => {
      b.classList.toggle('on', b.dataset.diff === game.difficulty);
    });
  }
  if (name === 'vs') refreshOnlineNote();
  if (name === 'join') {
    $('btnJoinGo').disabled = false;
    $('joinCode').value = '';
    setStatus('joinStatus', '');
  }
}

// --- 合言葉のコピー ----------------------------------------------------------
let copyTimer = 0;

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

function selectRoomCode() {
  try {
    const range = document.createRange();
    range.selectNodeContents($('roomCode'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch (e) { return false; }
}

async function copyRoomCode() {
  const code = $('roomCode').textContent.trim();
  if (code.length !== 4) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(code);
    ok = true;
  } catch (e) {
    ok = legacyCopy(code);       // クリップボード API が使えない環境向け
  }
  const btn = $('btnCopyCode');
  if (!ok) selectRoomCode();     // せめて選択状態にして手動コピーできるようにする
  btn.textContent = ok ? 'コピーしました' : '選択しました';
  btn.classList.toggle('done', ok);
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    btn.textContent = 'コピー';
    btn.classList.remove('done');
  }, 1600);
}

// --- 部屋をつくる (ホスト) ---------------------------------------------------
function hostRoom() {
  $('roomCode').textContent = '\u00b7\u00b7\u00b7\u00b7';
  $('btnCopyCode').disabled = true;
  $('btnCopyCode').textContent = 'コピー';
  $('btnCopyCode').classList.remove('done');
  setStatus('hostStatus', '部屋をつくっています…');
  game.net = 'host';
  Net.host({
    onCode: (code) => {
      $('roomCode').textContent = code;
      $('btnCopyCode').disabled = false;
      setStatus('hostStatus', 'あいての参加を待っています…');
    },
    onConnect: () => {
      setStatus('hostStatus', 'あいてが参加しました。準備しています…');
      netSend({ t: 'hello', v: 1, roster: netRoster });
    },
    onMessage: onNetMessage,
    onClose: (why) => { game.net = 'none'; returnToTitle(why); },
    onError: (why) => { game.net = 'none'; setStatus('hostStatus', why, true); },
  });
}

// --- 合言葉で参加 (ゲスト) ---------------------------------------------------
function joinRoom() {
  const code = ($('joinCode').value || '').trim().toUpperCase();
  if (code.length !== 4) { setStatus('joinStatus', '合言葉は4文字です。', true); return; }
  $('btnJoinGo').disabled = true;
  setStatus('joinStatus', '接続しています…');
  game.net = 'guest';
  Net.join(code, {
    onConnect: () => setStatus('joinStatus', 'つながりました。準備しています…'),
    onMessage: onNetMessage,
    onClose: (why) => { game.net = 'none'; $('btnJoinGo').disabled = false; returnToTitle(why); },
    onError: (why) => { game.net = 'none'; $('btnJoinGo').disabled = false; setStatus('joinStatus', why, true); },
  });
}

document.querySelectorAll('.mode[data-mode]').forEach((btn) => {
  btn.disabled = true;
  btn.addEventListener('click', () => {
    const m = btn.dataset.mode;
    if (m === 'cpu') showStep('diff');
    else if (m === 'vs') showStep('vs');
    else { netLeave(); startGame(m); }
  });
});
document.querySelectorAll('.mode[data-diff]').forEach((btn) => {
  btn.addEventListener('click', () => {
    netLeave();
    game.difficulty = btn.dataset.diff;
    startGame('cpu');
  });
});
document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => { netLeave(); showStep(btn.dataset.back); });
});

$('btnLocalVs').addEventListener('click', () => { netLeave(); startGame('vs'); });
$('btnHost').addEventListener('click', () => { showStep('host'); hostRoom(); });
$('btnJoin').addEventListener('click', () => showStep('join'));
$('btnJoinGo').addEventListener('click', joinRoom);
$('btnCopyCode').addEventListener('click', copyRoomCode);
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

$('btnRetry').addEventListener('click', () => {
  // オンラインの再戦はホストが開始する
  if (game.net === 'guest') {
    netSend({ t: 'rematch' });
    $('resultText').textContent = 'あいての「もう一度」を待っています…';
    return;
  }
  startGame(game.mode);
});
$('btnTitle').addEventListener('click', () => {
  netLeave();
  game.state = 'title';
  resultPanel.hidden = true;
  titlePanel.hidden = false;
  showStep('mode');
  overlay.classList.add('show');
});

// ============================================================================
// 画面サイズ
// ============================================================================
function resize() {
  const r = stageEl.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;

  // 基本は「横幅いっぱい = ワールド幅 VIEW_W」。
  // それだと縦に見える範囲が狭くなりすぎる横長画面のときだけ、縦に合わせて縮める。
  let scale = r.width / VIEW_W;
  if (r.height / scale < MIN_VIEW_H) scale = r.height / MIN_VIEW_H;

  view.scale = scale;
  view.w = r.width / scale;
  view.h = r.height / scale;
  // 画面の下に芝生が TURF_MARGIN だけ覗くように台座の高さを決める
  view.anchor = Math.min(view.h - (TURF_Y - GROUND_Y) - TURF_MARGIN, view.h * 0.82);
  // 待機中のウマ娘が画面上端からはみ出さない位置に塔のてっぺんを置く
  view.top = Math.max(view.h * TOP_RATIO, PIECE_H + DROP_GAP + 74);

  // 左右いっぱいまで置けるようにする (端に寄せすぎると台座に届かないので上限あり)
  const reach = Math.min(view.w / 2 - 46, PEDESTAL_W / 2 + 90);
  AIM_MIN = CX - reach;
  AIM_MAX = CX + reach;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  renderScale = scale * dpr;
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(stageEl);

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ?debug 付きで開いたときだけ、外から 1 フレーム進められるようにする
if (location.search.includes('debug')) {
  window.UmaDebug = { game, engine, tick, start: startGame, drop: dropPiece, plan: planCpuMove, placed: () => placed };
}

// ------------------------------- 起動 --------------------------------------
resize();
buildStage();
requestAnimationFrame(loop);
boot();

})();
