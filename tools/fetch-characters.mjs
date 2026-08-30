// 公式ポータル (umamusume.jp) のキャラクター一覧から、キャラ名と公式立ち絵の URL を集めて
// data/characters.js を生成する。画像そのものは保存せず、URL だけを参照する。
//
//   node tools/fetch-characters.mjs
//
// 一覧ページの HTML には、各キャラの一覧用バストアップ (<slug>_list.png) と、
// 詳細ページ用の全身立ち絵 (<slug>_01.png) の両方の URL が埋まっている。
// 名前は前者の alt 属性から取れるので、slug を鍵にして後者と突き合わせる。
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_URL = 'https://umamusume.jp/character/';
const OUT = join(ROOT, 'data', 'characters.js');

/** バストアップ画像の alt から「slug と日本語名」を、周辺の markup から英語名を拾う */
function collectNames(html) {
  const found = new Map();
  const re = /<img\s+src="(https:\/\/images\.microcms-assets\.io\/[^"]+?\/([^"/]+?)_list\.png)"\s+alt="([^"]*)"/g;
  for (const m of html.matchAll(re)) {
    const [, , slug, ja] = m;
    if (!ja || found.has(slug)) continue;
    // 直後の dt-bg に英語表記が入っている
    const near = html.slice(m.index, m.index + 800);
    const en = near.match(/<div class="dt-bg"[^>]*>\s*<p[^>]*>([^<]*)<\/p>/);
    found.set(slug, { slug, ja, en: en ? en[1].trim() : '' });
  }
  return found;
}

/** 全身立ち絵 <slug>_01.png を slug -> URL で集める */
function collectStandings(html) {
  const found = new Map();
  const re = /https:\/\/images\.microcms-assets\.io\/[^"'\s)]+?\/([^"'/\s)]+?)_01\.png/g;
  for (const m of html.matchAll(re)) {
    if (!found.has(m[1])) found.set(m[1], m[0]);
  }
  return found;
}

function toSource(list) {
  const lines = [
    '// ウマ娘 プリティーダービー 公式ポータルサイト (https://umamusume.jp/character/) の',
    '// キャラクター一覧に掲載されている立ち絵画像を URL 参照で利用します。',
    '// 画像は microCMS (imgix) 配信で CORS 許可済みのため、canvas でシルエット抽出ができます。',
    '// (C) Cygames, Inc.',
    '//',
    '// このファイルは tools/fetch-characters.mjs が生成します。手で編集しないでください。',
    '',
    'const CHARACTERS = [',
  ];
  for (const c of list) {
    lines.push(`  { id: ${JSON.stringify(c.id)}, name: ${JSON.stringify(c.name)}, `
      + `en: ${JSON.stringify(c.en)}, url: ${JSON.stringify(c.url)} },`);
  }
  lines.push('];');
  lines.push('');
  lines.push('// imgix のパラメータで「高さ」を指定して縮小する。立ち絵は縦長なので幅ではなく高さで揃える。');
  lines.push('function characterImageUrl(ch, height) {');
  lines.push("  return ch.url + '?h=' + height + '&fm=png';");
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

const res = await fetch(LIST_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
if (!res.ok) throw new Error(`${LIST_URL} が ${res.status} を返しました`);
const html = await res.text();

const names = collectNames(html);
const standings = collectStandings(html);
console.log(`名前 ${names.size} 件 / 立ち絵 ${standings.size} 件を検出`);

const list = [];
const missing = [];
for (const { slug, ja, en } of names.values()) {
  // ライスシャワーだけ一覧側の slug が riceshower_01 になっているので後ろの _01 も外して探す
  const url = standings.get(slug) || standings.get(slug.replace(/_01$/, ''));
  if (!url) { missing.push(slug); continue; }
  list.push({ id: slug, name: ja, en, url });
}

if (!list.length) throw new Error('1件も取得できませんでした。公式サイトの構造が変わった可能性があります。');
if (missing.length) console.warn(`立ち絵が見つからず除外: ${missing.join(', ')}`);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, toSource(list), 'utf8');
console.log(`data/characters.js に ${list.length} 件を書き出しました`);
