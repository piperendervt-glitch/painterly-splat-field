#!/usr/bin/env node
// プレビズの絵を下絵にして、ChatGPT の月額プラン（Codex CLI の画像生成）で絵画的な絵を作る。
//
//   node paint.mjs views --in <プレビズの書き出し> --out <出す所> [--views A,B] [--light free|flat|previz] [--style "..."] [--dry-run]
//     各視点の色の絵と奥行きの絵を Codex に見せ、同じ構図のまま絵画にしてもらう。
//     2 枚目からは、1 枚目にできた絵も「画風の見本」として見せる（視点ごとに画風がばらつかないように）。
//     出すもの：<視点>_painted.png（頼んだ大きさに合わせたもの）、<視点>_overlay.png（プレビズの輪郭を重ねた確かめ用）
//     --light は光の描かせ方（粒の光を後から付け替えるための描き分け）：
//       free   （既定）光は任せる。下絵は <視点>_color.png。出すものは上のとおり。
//       flat   光の少ない絵。曇り空の均一な光で、落ちる影を描かせない。下絵は <視点>_flat.png。出すものは <視点>_painted_flat.png、<視点>_overlay_flat.png。
//       previz プレビズの光に従う絵。下絵の日なた・日陰・落ちる影をそのまま守らせる。下絵は <視点>_lit.png。出すものは <視点>_painted_lit.png、<視点>_overlay_lit.png。
//
//   node paint.mjs fill --image <絵> --mask <穴の印（白が穴）> --out <出すファイル> [--style "..."] [--hint "..."] [--dry-run]
//     --hint は、穴の中に描く物についての追加の指示（1 文）。絵 1 枚から作った場面で、人を増やさないように頼むときなどに使う。
//                       [--previz <同じ視点のプレビズの絵> --depth <その奥行きの絵> --overlay <確かめ用の絵>] [--light free|flat|previz]
//     穴をマゼンタで塗った絵を見せて「マゼンタの所だけ描いて」と頼み、できた絵の穴の所だけを元の絵に貼る。
//     穴の外は 1 画素も変えない。
//     --sky を付けると、空だけの絵（空の天球の一部）として頼む：地面や物を描かせない。--style-ref <絵> は画風の見本（同じ場面の絵）。
//     --ground を付けると、周囲の地面の絵（30° 見下ろした広い画角の一部）として頼む：人や物を描かせない。--sky と同じく --style-ref が使える。
//     --plate を付けると、手前の物を消した背景の絵（背後の層の色）として頼む：穴は手前の物があった所で、その後ろの背景だけを描かせる。
//       --guide <絵> は、穴をツール内の計算で埋めた絵（どこに何の背景が来るかの目安）。
//
//   node paint.mjs layout --image <絵> --brief <カメラと奥行きの説明の文> --out <layout.json> [--depth <奥行きの絵>] [--dry-run]
//                         [--prev <今の layout.json> --overlay <絵に今の形を線で重ねた絵> --report <見比べた結果の文>]
//     絵を見せて、場面の大まかな形（箱と円柱の一覧）を layout.json に書いてもらう。絵は作らない（文だけ）。
//     --prev・--overlay・--report を付けると「直し」の回：今の形を絵に重ねたものと、奥行きとの見比べを見せて、書き直してもらう。
//     座標は、カメラの真下の地面を原点、+x = 絵の右、+y = 上、+z = 奥（m）。「粒の空間」の「AI に形の配置を書かせる」が使う。
//
// 共通：--codex <コマンド>（既定 codex）、--timeout <秒>（既定 600）
// fill だけ：--local [コマンド] で、Codex の代わりに手元の PC の画像生成モデルで描く（--local-model <名前>、--seed <数>。既定の待ち時間は 3600 秒）
//            --nvs [コマンド] --export-dir <previz-export> --view <視点> で、別視点の絵を生成するモデルの絵を穴に使う（--nvs-model <名前>、--refine [強さ] で仕上げ）
//            --nvs に --repaint を足すと、別視点のモデルの絵を「下絵」にして、Codex（ChatGPT）に穴を描いてもらう（視点は下絵のまま、画風はもとの絵）。
//              下絵は <出すファイルの所>/<視点>_layout.png に残る。--layout <絵> で、すでにある下絵（穴を埋めた、同じ視点の絵）を渡すと、モデルを呼ばずに Codex だけ動かす。
//              --style-ref <絵> は画風の見本（既定は、もとの視点の絵）。
//
//   node paint.mjs repaint --image <別視点の絵> --style-ref <もとの絵> --out <出すファイル> [--style "..."] [--hint "..."] [--overlay <確かめ用の絵>] [--dry-run]
//     別視点のモデルが作った絵を、構図と視点をそのままに、もとの絵の画風で 1 枚まるごと描き直してもらう（穴だけでなく全体）。
//
// --dry-run は Codex を呼ばず、作業フォルダに送る文（prompt.txt）と条件の絵だけを作る。利用枠は減らない。
import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt, generate, askJson } from './codex.mjs';
import { localInpaint, defaultCommand } from './localinpaint.mjs';
import { nvsJob, nvsGenerate, defaultNvsCommand } from './nvs.mjs';
import { readPng, writePng, resize, overlay, holeMask, paintHoles, composite, outsideChange } from './image.mjs';

const DEFAULT_STYLE = 'a loose, painterly oil painting with visible brush strokes, soft atmospheric perspective, warm late-afternoon light';
// 光を描き分けるときは、画風の文に光のことを入れない（光は LIGHT の文で決める）。
const DEFAULT_STYLE_NO_LIGHT = 'a loose, painterly oil painting with visible brush strokes and soft atmospheric perspective';

// 光の描かせ方ごとの、下絵にする絵・出すファイルの名前・光についての指示。
const LIGHT = {
  free: { ref: 'color', suffix: '', lines: [] },
  flat: {
    ref: 'flat', suffix: '_flat',
    lines: [
      'LIGHTING (most important): paint the scene under flat, even, shadowless light, like a bright overcast day. There is no sun.',
      'No directional light, no cast shadows on the ground or on any object, no sunlit sides and no dark shaded sides, no glowing highlights, no rim light, no sunset or golden tint.',
      'Every surface shows only its own local colour and painted surface texture, at about the same brightness whichever way it faces, like the even tones of previz.png. Surfaces that face upward may be very slightly lighter.',
      'This painting will be relit later by a program that adds the sun and the shadows, so any painted sunlight or shadow would be a mistake.',
      'Sky: a plain, pale, even overcast sky with only faint soft cloud texture, neutral in colour.',
    ],
  },
  previz: {
    ref: 'lit', suffix: '_lit',
    lines: [
      'LIGHTING (most important): previz.png already shows the exact lighting we need: neutral white sunlight from one fixed direction, with cast shadows.',
      'Keep that lighting exactly. The same surfaces are sunlit and the same surfaces are in shade as in previz.png, and every cast shadow stays in exactly the same place, shape and size as in previz.png.',
      'Do not add other light sources. Do not add shadows that are not in previz.png, and do not remove, move or blur away the ones that are there.',
      'The light colour is neutral white midday daylight: no sunset, golden-hour or coloured tint. Shaded areas are simply darker and slightly cooler.',
      'Sky: a clear daytime sky with a few light clouds, in neutral daylight colours. Do not paint the sun disc.',
    ],
  },
};

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: cmd };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function viewInstructions({ style, hasStyleRef, light = 'free' }) {
  return [
    `Repaint the scene shown in references/previz.png as ${style}.`,
    ...LIGHT[light].lines,
    'previz.png is a plain 3D render (previsualization) of the scene from the exact camera we need. depth.png is its depth map (white = near, black = far / sky).',
    'Keep the composition EXACTLY: same camera position, same horizon height, same perspective, same position, size and silhouette of every object (ground, arch, tower, etc.).',
    'Do not crop, zoom, pan, mirror, or add a border. The painting must line up with previz.png when overlaid pixel for pixel.',
    'Do not add large new objects that are not in previz.png. Small surface details (stones, grass, cracks, clouds) are welcome.',
    'Areas that are empty / sky in depth.png must stay sky.',
    hasStyleRef ? 'style.png is another view of the same place that is already painted. Match its painting style, palette, lighting and materials exactly so the two views look like the same painting.' : '',
  ].filter(Boolean).join('\n');
}

function fillInstructions({ style, hasPreviz, lightLines = [], hint = '' }) {
  return [
    `references/holes.png is ${style}. The bright magenta (#FF00FF) areas are holes with no paint yet.`,
    'Paint ONLY inside the magenta areas, continuing the surrounding scene naturally (same perspective, same light, same brush style).',
    'Everything outside the magenta areas must stay exactly as it is: same composition, same position of everything. Do not crop, zoom or shift the image.',
    'No magenta may remain in the result.',
    ...lightLines,
    hasPreviz ? 'previz.png is a plain 3D render of the same scene from the same camera, and depth.png is its depth map (white = near, black = far / sky). Inside the magenta areas, follow previz.png exactly for the position, size and silhouette of every object, and keep sky where depth.png is black. Use previz.png only for layout, not for colour or style.' : '',
    hint,
  ].filter(Boolean).join('\n');
}

// 別視点のモデルの絵を下絵にして、穴を描いてもらうときの文。layout.png = 穴に下絵をはめた絵、style.png = もとの絵
function layoutFillInstructions({ style, hasStyleRef, hint = '' }) {
  return [
    `references/holes.png is ${style}. The bright magenta (#FF00FF) areas are holes with no paint yet.`,
    'references/layout.png is the same picture from exactly the same camera, with the holes filled in by an automatic view-synthesis model. It shows WHAT lies in each hole and WHERE. Inside the magenta areas, follow layout.png for the position, size and silhouette of everything: the horizon and shoreline, ground and water, tree trunks and foliage, figures, objects and cast shadows.',
    'layout.png is low in resolution and blurry inside the holes, and its colours and texture there may be smeared, washed out or photographic. Do NOT copy its texture or blur. Paint the same content as a real part of the painting: the same brush or dot texture, dot size, palette, light and level of detail as the painted parts around the holes.',
    'Where layout.png shows only a shapeless smear or an obvious artefact inside a hole, paint the most natural continuation of the surrounding scene instead.',
    'Do not add people, animals, boats, buildings or other objects that are not in layout.png, and do not leave out or move the ones that are.',
    hasStyleRef ? 'style.png is the original painting that this view belongs to, seen from its original camera. Match its painting technique, palette, light and atmosphere exactly, so that this view looks like another part of the same canvas. Use style.png for style only (and to recognise things that reappear here); the composition comes from holes.png and layout.png.' : '',
    'Paint ONLY inside the magenta areas. Everything outside the magenta areas must stay exactly as it is: same camera, same composition, same position of everything. Do not crop, zoom, shift or mirror the image. No magenta may remain in the result.',
    hint,
  ].filter(Boolean).join('\n');
}

// 別視点のモデルの絵を、1 枚まるごと、もとの絵の画風で描き直してもらうときの文。view.png = 別視点の絵、style.png = もとの絵
function repaintInstructions({ style, hasStyleRef, hint = '' }) {
  return [
    `Repaint the picture in references/view.png as ${style}.`,
    hasStyleRef
      ? 'view.png shows the scene of the painting style.png from a different camera position. It was made by an automatic view-synthesis model, so it is low in resolution and blurry, and parts of it are smeared or look photographic.'
      : 'view.png was made by an automatic view-synthesis model, so it is low in resolution and blurry, and parts of it are smeared or look photographic.',
    'Keep the camera and the composition of view.png EXACTLY: the same viewpoint, the same horizon height, the same perspective, and the same position, size and silhouette of everything in it (ground, water, shoreline, trees, figures, objects, cast shadows).',
    'Do not crop, zoom, pan, mirror or add a border. The painting must line up with view.png when overlaid pixel for pixel.',
    'Do not add people, animals, boats, buildings or other objects that are not in view.png, and do not leave out or move the ones that are. Where view.png shows only a shapeless smear, paint the most natural continuation of the scene around it.',
    hasStyleRef ? 'style.png is the original painting. Match its painting technique, brush or dot texture and dot size, palette, light and atmosphere exactly, so that the result looks like the same canvas seen from the new position. Use style.png for style only, not for composition: do NOT return to its camera position.' : '',
    'Do not copy the blur or the texture of view.png: every part of the result must be crisp painted texture.',
    hint,
  ].filter(Boolean).join('\n');
}

// 空の天球の穴を描いてもらうときの文。絵は空だけ（30° 見上げた広い画角）。下の方は地平線より下なので、もやにする。
function skyInstructions({ style, hasStyleRef, lightLines = [] }) {
  return [
    `references/holes.png is one part of a painted sky backdrop (a sky dome for a 3D scene), painted as ${style}. It looks up at about 30 degrees with a very wide lens, so the top of the image is straight overhead and the lower part is at and below the horizon.`,
    'The bright magenta (#FF00FF) areas are holes with no paint yet. Paint ONLY inside the magenta areas, continuing the existing sky naturally: the same sky colours at the same height, the same kind and scale of clouds, the same light and the same brush style.',
    'This image is SKY ONLY. Do not paint ground, sea, hills, mountains, trees, buildings, birds, people, the sun disc, the moon, stars, text or a frame. Nothing but sky, clouds and haze.',
    'Near the bottom edge, let the sky fade into plain soft horizon haze, with no horizon line and no objects.',
    'Everything outside the magenta areas must stay exactly as it is. Do not crop, zoom or shift the image. No magenta may remain in the result.',
    'guide.png shows the same image with the holes filled by a blurry automatic guess. Use it only as a rough guide for the overall colour at each height; paint real clouds and brush texture instead of its blur.',
    hasStyleRef ? 'style.png is a painting of the scene that this sky belongs to. Match the colours, clouds and brushwork of its sky. Do not copy its ground or objects.' : '',
    ...lightLines.filter((l) => l.startsWith('Sky:')),
  ].filter(Boolean).join('\n');
}

// 周囲の地面を描いてもらうときの文。絵は、目の高さから 30° 見下ろした広い画角。上の方が地平線とその上、下の端が足もと。
function groundInstructions({ style, hasStyleRef }) {
  return [
    `references/holes.png is one part of a painted ground backdrop for a 3D scene, painted as ${style}. It is seen from eye height, looking down at about 30 degrees with a very wide lens: the horizon is in the upper part of the image, and the bottom edge is the ground right at the viewer's feet.`,
    'The bright magenta (#FF00FF) areas are holes with no paint yet. Paint ONLY inside the magenta areas, continuing the existing ground naturally in every direction: the same kind of ground (grass, earth, sand, shore, water) with the same colours, the same light and the same brush style, in correct perspective (texture gets smaller towards the horizon).',
    'This image is EMPTY GROUND ONLY. Do not paint people, animals, trees, bushes with trunks, rocks larger than pebbles, buildings, fences, paths with objects, shadows of objects, text or a frame.',
    'The plain flat band at the top of the image (above the horizon) is only a placeholder for the sky. Leave it exactly as it is, and let the ground fade softly into haze just below it.',
    'Everything outside the magenta areas must stay exactly as it is. Do not crop, zoom or shift the image. No magenta may remain in the result.',
    'guide.png shows the same image with the holes filled by a blurry automatic guess. Use it only as a rough guide for the overall colour at each distance; paint real ground texture and brush strokes instead of its blur.',
    hasStyleRef ? 'style.png is a painting of the scene that this ground belongs to. Match the colours and brushwork of its ground. Do not copy its people, trees or objects.' : '',
  ].filter(Boolean).join('\n');
}

// 手前の物を消した背景の絵（背後の層の色）を描いてもらうときの文。穴は、手前の物（人・幹・柱など）があった所。
function plateInstructions({ hasGuide }) {
  return [
    'references/holes.png is a picture of a scene from which the foreground objects (for example people, animals, tree trunks, posts, stone pillars or arches) have been cut out. The cut-out areas are bright magenta (#FF00FF).',
    'Paint ONLY inside the magenta areas. Paint what lies BEHIND the removed objects: continue the surrounding background (ground, grass, water, distant trees, hills, sky) straight through every hole, as if the objects had never been there.',
    'The result must be an EMPTY background plate. Do NOT paint any person, animal, tree trunk, pillar, arch, wall, post, building or any other object inside the holes, and do not redraw the outline, silhouette or shadow shape of what was removed.',
    'Keep horizons, shorelines and the edges between ground, water, far trees and sky continuous across the holes.',
    hasGuide ? 'guide.png shows the same picture with the holes filled by a blurry automatic guess. Use it only as a rough guide for which kind of background (ground / water / far trees / sky) and which overall colour belongs where; paint real surface texture and brush strokes instead of its blur and smears.' : '',
    'Match the surrounding picture exactly: the same brushwork or dot texture, palette, light and level of detail, so that the filled areas cannot be told apart from the rest.',
    'Everything outside the magenta areas must stay exactly as it is: same composition, same position of everything. Do not crop, zoom or shift the image. No magenta may remain in the result.',
  ].filter(Boolean).join('\n');
}

async function runViews(o) {
  if (!o.in || !o.out) throw new Error('使い方：node paint.mjs views --in <プレビズの書き出し> --out <出す所> [--views A,B]');
  const cams = JSON.parse(fs.readFileSync(path.join(o.in, 'cameras.json'), 'utf8'));
  const wanted = typeof o.views === 'string' ? o.views.split(',').map((s) => s.trim()) : null;
  const views = cams.views.filter((v) => !wanted || wanted.includes(v.name));
  if (!views.length) throw new Error('視点が見つかりません');
  const light = typeof o.light === 'string' ? o.light : 'free';
  if (!LIGHT[light]) throw new Error('--light は free / flat / previz のどれかです');
  const { ref, suffix } = LIGHT[light];
  for (const v of views) {
    if (!v[ref] || !fs.existsSync(path.join(o.in, v[ref]))) throw new Error(`プレビズの書き出しに ${v.name}_${ref}.png がありません。「プレビズ」の画面で保存し直してください（光の描き分けには新しい書き出しが要ります）。`);
  }
  const style = typeof o.style === 'string' ? o.style : (light === 'free' ? DEFAULT_STYLE : DEFAULT_STYLE_NO_LIGHT);
  fs.mkdirSync(o.out, { recursive: true });
  const runDir = path.join(o.out, 'work', stamp());
  let styleRef = typeof o['style-ref'] === 'string' ? o['style-ref'] : null;
  const report = [];

  for (const v of views) {
    const workDir = path.join(runDir, v.name);
    fs.mkdirSync(workDir, { recursive: true });
    const references = [
      { name: 'previz.png', file: path.join(o.in, v[ref]), note: 'previz render from the target camera (layout to follow exactly)' },
      { name: 'depth.png', file: path.join(o.in, v.depth_view), note: 'depth of previz.png (white = near, black = far / sky)' },
    ];
    if (styleRef) references.push({ name: 'style.png', file: styleRef, note: 'already painted view of the same place (style to match)' });
    const prompt = buildPrompt({ width: v.width, height: v.height, references, instructions: viewInstructions({ style, hasStyleRef: !!styleRef, light }) });
    console.log(`視点 ${v.name}：${o['dry-run'] ? '文と条件の絵を用意します（Codex は呼びません）' : 'Codex で描いています（30 秒〜数分）'}`);
    const started = Date.now();
    const file = await generate({ workDir, prompt, references, command: o.codex || 'codex', timeoutSeconds: Number(o.timeout) || 600, dryRun: !!o['dry-run'] });
    if (!file) { console.log(`  → ${workDir}`); continue; }
    const raw = readPng(file);
    const painted = resize(raw, v.width, v.height);
    const out = path.join(o.out, `${v.name}_painted${suffix}.png`);
    writePng(out, painted);
    writePng(path.join(o.out, `${v.name}_overlay${suffix}.png`), overlay(painted, readPng(path.join(o.in, v[ref]))));
    fs.copyFileSync(file, path.join(workDir, `raw${path.extname(file)}`));
    const seconds = Math.round((Date.now() - started) / 1000);
    report.push({ view: v.name, painted: path.basename(out), raw_size: [raw.width, raw.height], size: [v.width, v.height], seconds });
    console.log(`  → ${out}（生成 ${raw.width}x${raw.height}${raw.width !== v.width || raw.height !== v.height ? ` を ${v.width}x${v.height} に合わせた` : ''}、${seconds} 秒）`);
    if (!styleRef) styleRef = out;
  }
  if (report.length) fs.writeFileSync(path.join(o.out, `paint_report${suffix}.json`), JSON.stringify({ style, light, cameras: 'cameras.json と同じ', views: report }, null, 2));
}

async function runFill(o) {
  if (!o.image || !o.mask || !o.out) throw new Error('使い方：node paint.mjs fill --image <絵> --mask <穴の印（白が穴）> --out <出すファイル>');
  const light = typeof o.light === 'string' ? o.light : 'free'; // 視点の絵と同じ光の描き方で、穴も描く
  if (!LIGHT[light]) throw new Error('--light は free / flat / previz のどれかです');
  const style = typeof o.style === 'string' ? o.style : (light === 'free' ? DEFAULT_STYLE : DEFAULT_STYLE_NO_LIGHT);
  const original = readPng(o.image);
  const maskImg = resize(readPng(o.mask), original.width, original.height);
  const mask = holeMask(maskImg, Number(o.grow ?? 2));
  const holes = mask.reduce((s, x) => s + x, 0);
  if (!holes) throw new Error('穴の印に白い所がありません');
  const workDir = path.join(path.dirname(path.resolve(o.out)), 'work', `fill-${stamp()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const holesFile = path.join(workDir, 'holes-input.png');
  writePng(holesFile, paintHoles(original, mask));
  const references = [{ name: 'holes.png', file: holesFile, note: o.plate ? 'picture with the foreground objects cut out (magenta holes to fill with background)' : 'painting with magenta holes to fill' }];
  const ground = !!o.ground, sky = !!o.sky || ground, hasStyleRef = sky && typeof o['style-ref'] === 'string'; // 周囲の地面は、空と同じ形（目安の絵・画風の見本）で頼む
  if (sky) references.push({ name: 'guide.png', file: o.image, note: 'the same image with the holes filled by a blurry automatic guess (rough colour guide only)' });
  if (hasStyleRef) references.push({ name: 'style.png', file: o['style-ref'], note: ground ? 'painting of the scene this ground belongs to (style and ground colours to match)' : 'painting of the scene this sky belongs to (style and sky colours to match)' });
  const plate = !sky && !!o.plate, hasGuide = plate && typeof o.guide === 'string';
  if (hasGuide) references.push({ name: 'guide.png', file: o.guide, note: 'the same picture with the holes filled by a blurry automatic guess (rough guide only)' });
  const hasPreviz = !sky && !plate && typeof o.previz === 'string';
  if (hasPreviz) references.push({ name: 'previz.png', file: o.previz, note: 'previz render from the same camera (layout to follow inside the holes)' });
  if (hasPreviz && typeof o.depth === 'string') references.push({ name: 'depth.png', file: o.depth, note: 'depth of previz.png (white = near, black = far / sky)' });
  const prompt = buildPrompt({ width: original.width, height: original.height, references, instructions: ground ? groundInstructions({ style, hasStyleRef }) : sky ? skyInstructions({ style, hasStyleRef, lightLines: LIGHT[light].lines }) : plate ? plateInstructions({ hasGuide }) : fillInstructions({ style, hasPreviz, lightLines: LIGHT[light].lines, hint: typeof o.hint === 'string' ? o.hint : '' }) });
  // --local：Codex の代わりに、手元の PC の画像生成モデルで穴を描く（利用枠を使わない。paint/localinpaint.mjs）
  // --nvs  ：別視点の絵を生成するモデルに、この視点から見た絵を作ってもらい、穴に使う（paint/nvs.mjs）。--export-dir と --view が要る
  // --refine [強さ]：--nvs の絵は粗いので、穴の中を PC の画像生成モデルで描き直して、絵の細かさを戻す（強さ 0〜1、既定 0.45）
  const cmdOf = (v, fallback) => (v ? (typeof v === 'string' && v.trim() ? v.trim() : fallback()) : '');
  const nvs = cmdOf(o.nvs, defaultNvsCommand), local = cmdOf(o.local, defaultCommand), refine = nvs && o.refine !== undefined;
  // --repaint / --layout：別視点のモデルの絵（下絵）で視点と構図を決め、Codex に、もとの絵の画風で穴を描いてもらう
  const givenLayout = !sky && !plate && typeof o.layout === 'string' ? o.layout : null, repaint = !sky && !plate && ((nvs && !!o.repaint) || !!givenLayout);
  if (repaint && refine) throw new Error('--repaint（Codex で描く）と --refine（PC のモデルで仕上げる）は、どちらか片方にしてください');
  const hint = typeof o.hint === 'string' ? o.hint : '', seed = o.seed !== undefined && o.seed !== true && Number.isFinite(Number(o.seed)) ? Number(o.seed) : undefined;
  console.log(`穴 ${(100 * holes / mask.length).toFixed(1)}%：${givenLayout ? `下絵（${path.basename(givenLayout)}）をもとに、${o['dry-run'] ? '文と条件の絵を用意します（Codex は呼びません）' : 'Codex で描いています'}` : o['dry-run'] && !(nvs && repaint) ? '文と条件の絵を用意します（Codex は呼びません）' : nvs ? '別視点の絵を生成するモデルで描いています' : local ? 'PC の生成モデルで描いています' : 'Codex で描いています'}`);
  let file;
  if (givenLayout) file = null; // 下絵はもうある。下で Codex に渡す
  else if ((nvs || local) && (!o['dry-run'] || (nvs && repaint))) {
    fs.mkdirSync(path.join(workDir, 'references'), { recursive: true });
    fs.copyFileSync(holesFile, path.join(workDir, 'references', 'holes.png'));
    const base = { style, hint, width: original.width, height: original.height, ...(seed !== undefined ? { seed } : {}) };
    const localModel = typeof o['local-model'] === 'string' && o['local-model'].trim() ? { model: o['local-model'].trim() } : {};
    if (nvs) {
      if (typeof o['export-dir'] !== 'string' || typeof o.view !== 'string') throw new Error('--nvs には --export-dir <previz-export> と --view <視点の名前> が要ります');
      const job = nvsJob({ exportDir: o['export-dir'], paintDir: path.dirname(path.resolve(o.out)), view: o.view, holesFile, workDir, style, hint, model: typeof o['nvs-model'] === 'string' ? o['nvs-model'].trim() : '', seed });
      file = await nvsGenerate({ command: nvs, workDir, job, timeoutSeconds: Number(o.timeout) || 7200 });
      if (refine) { // 生成した絵を穴にはめた絵から、穴の中だけを描き直す
        const init = path.join(workDir, 'nvs-composite.png');
        writePng(init, composite(original, resize(readPng(file), original.width, original.height), mask));
        fs.copyFileSync(file, path.join(workDir, 'nvs-raw.png'));
        const strength = Number.isFinite(Number(o.refine)) && o.refine !== true ? Math.min(1, Math.max(0.05, Number(o.refine))) : 0.45;
        console.log(`  絵の細かさを戻す仕上げ（強さ ${strength}）を PC の生成モデルでしています`);
        file = await localInpaint({ command: cmdOf(o.local || true, defaultCommand), workDir, holesFile, job: { ...base, ...localModel, init, strength }, timeoutSeconds: Number(o.timeout) || 3600, outName: 'refined.png' });
      }
    } else file = await localInpaint({ command: local, workDir, holesFile, job: { ...base, ...localModel }, timeoutSeconds: Number(o.timeout) || 3600 });
  } else file = await generate({ workDir, prompt, references, command: o.codex || 'codex', timeoutSeconds: Number(o.timeout) || 600, dryRun: !!o['dry-run'] });
  if (repaint) {
    // 下絵 = 穴に別視点のモデルの絵をはめた絵（穴の外は今の絵のまま）。視点ごとに残しておく（Codex だけやり直せるように）
    const layout = givenLayout ? resize(readPng(givenLayout), original.width, original.height) : composite(original, resize(readPng(file), original.width, original.height), mask);
    const layoutFile = path.join(workDir, 'layout-input.png');
    writePng(layoutFile, layout);
    if (!givenLayout && typeof o.view === 'string' && /^[A-Za-z0-9_-]+$/.test(o.view)) writePng(path.join(path.dirname(path.resolve(o.out)), `${o.view}_layout.png`), layout);
    let styleRef = typeof o['style-ref'] === 'string' ? o['style-ref'] : null;
    if (!styleRef && typeof o['export-dir'] === 'string') { // 既定の見本は、もとの視点の絵
      const cams = JSON.parse(fs.readFileSync(path.join(o['export-dir'], 'cameras.json'), 'utf8')), dir = path.dirname(path.resolve(o.out));
      const src = cams.views.find((v) => fs.existsSync(path.join(dir, `${v.name}_painted.png`)));
      if (src) styleRef = path.join(dir, `${src.name}_painted.png`);
    }
    const refs = [
      { name: 'holes.png', file: holesFile, note: 'painting with magenta holes to fill' },
      { name: 'layout.png', file: layoutFile, note: 'the same picture from the same camera with the holes filled by a view-synthesis model (layout to follow inside the holes; not its texture)' },
      ...(styleRef ? [{ name: 'style.png', file: styleRef, note: 'the original painting (style, palette and atmosphere to match)' }] : []),
    ];
    const text = buildPrompt({ width: original.width, height: original.height, references: refs, instructions: layoutFillInstructions({ style, hasStyleRef: !!styleRef, hint }) });
    const codexDir = path.join(workDir, 'codex'); // 別視点のモデルの作業の物と混ざらないように、Codex は別のフォルダで動かす
    fs.mkdirSync(codexDir, { recursive: true });
    console.log(`  ${o['dry-run'] ? '下絵ができました。Codex に送る文と条件の絵を用意します（Codex は呼びません）' : '下絵ができました。Codex で、もとの絵の画風で描いています（30 秒〜数分）'}`);
    file = await generate({ workDir: codexDir, prompt: text, references: refs, command: o.codex || 'codex', timeoutSeconds: Number(o['codex-timeout']) || 600, dryRun: !!o['dry-run'] });
    if (!file) { console.log(`  → ${codexDir}`); return; }
  }
  if (!file) { console.log(`  → ${workDir}`); return; }
  const generated = resize(readPng(file), original.width, original.height);
  const result = composite(original, generated, mask);
  writePng(o.out, result);
  if (hasPreviz && typeof o.overlay === 'string') writePng(o.overlay, overlay(result, resize(readPng(o.previz), original.width, original.height)));
  const drift = outsideChange(original, generated, mask);
  console.log(`  → ${o.out}（穴の外の変わり具合 ${drift.toFixed(1)}/255。${drift > 25 ? '大きい：絵全体が描き直されたかも。継ぎ目を見てください' : '小さい：位置は合っていそう'}）`);
}

// 別視点のモデルが作った絵を、構図をそのままに、もとの絵の画風で 1 枚まるごと描き直してもらう
async function runRepaint(o) {
  if (!o.image || !o.out) throw new Error('使い方：node paint.mjs repaint --image <別視点の絵> --style-ref <もとの絵> --out <出すファイル>');
  const view = readPng(o.image), style = typeof o.style === 'string' ? o.style : DEFAULT_STYLE;
  const styleRef = typeof o['style-ref'] === 'string' ? o['style-ref'] : null;
  const workDir = path.join(path.dirname(path.resolve(o.out)), 'work', `repaint-${stamp()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const references = [
    { name: 'view.png', file: o.image, note: 'picture from the target camera made by a view-synthesis model (composition to keep exactly)' },
    ...(styleRef ? [{ name: 'style.png', file: styleRef, note: 'the original painting (style, palette and atmosphere to match)' }] : []),
  ];
  const prompt = buildPrompt({ width: view.width, height: view.height, references, instructions: repaintInstructions({ style, hasStyleRef: !!styleRef, hint: typeof o.hint === 'string' ? o.hint : '' }) });
  console.log(`別視点の絵（${view.width}x${view.height}）を描き直します：${o['dry-run'] ? '文と条件の絵を用意します（Codex は呼びません）' : 'Codex で描いています（30 秒〜数分）'}`);
  const started = Date.now();
  const file = await generate({ workDir, prompt, references, command: o.codex || 'codex', timeoutSeconds: Number(o.timeout) || 600, dryRun: !!o['dry-run'] });
  if (!file) { console.log(`  → ${workDir}`); return; }
  const raw = readPng(file), painted = resize(raw, view.width, view.height);
  writePng(o.out, painted);
  fs.copyFileSync(file, path.join(workDir, `raw${path.extname(file)}`));
  if (typeof o.overlay === 'string') writePng(o.overlay, overlay(painted, view));
  console.log(`  → ${o.out}（生成 ${raw.width}x${raw.height}${raw.width !== view.width || raw.height !== view.height ? ` を ${view.width}x${view.height} に合わせた` : ''}、${Math.round((Date.now() - started) / 1000)} 秒）`);
}

// ---- 形の配置（箱と円柱の一覧）を書いてもらう ----
function layoutPrompt({ brief, hasDepth, refine, report }) {
  return [
    'You are estimating a simple 3D blockout (a previz model) of the scene shown in a painting, as a list of primitive shapes. Do not generate any image.',
    '',
    'Files in your working directory (load the images with view_image):',
    '  - references/picture.png : the painting',
    hasDepth ? '  - references/depth.png : estimated depth of the same view (white = near, black = far, pure black = sky)' : null,
    refine ? '  - references/overlay.png : the painting with the CURRENT layout drawn over it (each shape as a coloured wireframe with its number; the legend of numbers is in the report below)' : null,
    refine ? '  - references/layout.json : the CURRENT layout' : null,
    '',
    'Camera and measurements:',
    brief.trim(),
    '',
    'Coordinate system (metres): the origin is the point on the ground directly below the camera. +x = towards the right of the picture, +y = up, +z = forward, away from the camera along the ground. The ground is the plane y = 0.',
    '',
    'Task: write a file named layout.json in the current working directory with this exact structure:',
    '{',
    '  "objects": [',
    '    { "name": "short_snake_case_name", "shape": "box", "center": [x, y, z], "size": [width_along_x, height_along_y, depth_along_z], "yaw_deg": 0 },',
    '    { "name": "another_name", "shape": "cylinder", "center": [x, y, z], "radius": 0.5, "height": 2.0 }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- List every solid thing a walking person could bump into: people, animals, tree trunks, pillars, walls, towers, buildings, boats, large rocks. An arch or gate is two leg boxes plus one lintel box across the top, so the opening stays open. Between 1 and 40 objects.',
    '- Do NOT list the ground, water, sky, clouds, shadows, grass or leaves.',
    '- "center" is the centre of the shape: a 1.7 m tall person standing on the ground is a box with center y = 0.85 and height 1.7. Shapes rest on the ground (bottom at y = 0) unless they are clearly raised.',
    '- "yaw_deg" turns a box about the vertical axis (0 = its sides are parallel to x and z; positive = counter-clockwise seen from above). Cylinders are upright.',
    '- Place every object with the depth table: it gives the 3D position (x, y, z) of what is seen at sample pixels. Find the samples on the object (and where it touches the ground), interpolate between them, and take the width and height from the positions of its left, right, top and bottom edges.',
    '- The side of a shape that faces away from the camera cannot be seen: guess a plausible depth (a person about 0.5 m, a wall or arch about one fifth of its width).',
    refine ? '- This is a correction round. overlay.png shows where the current shapes land in the picture, and the report below compares every shape with the depth map and with the outlines of the objects in the picture. Move, resize, split, add or delete shapes so that each wireframe sits exactly on its object. Then write the COMPLETE corrected layout.json (all objects, not only the changed ones).' : null,
    refine ? '' : null,
    refine ? 'Report on the current layout:' : null,
    refine ? report.trim() : null,
    '',
    'Write only valid JSON into layout.json (no comments, no trailing commas). Do not modify the files under references/. Do not ask for confirmation: write the file, then stop.',
  ].filter((l) => l !== null).join('\n');
}
const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);
/** Codex が書いた配置を、決まった形に整える（読めない物は捨てる）。 */
function cleanLayout(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.objects) ? raw.objects : [];
  const objects = [], names = new Set();
  for (const it of list.slice(0, 60)) {
    if (!it || typeof it !== 'object' || !Array.isArray(it.center)) continue;
    const center = [num(it.center[0], -2000, 2000), num(it.center[1], -200, 500), num(it.center[2], -2000, 2000)];
    if (center.includes(null)) continue;
    let name = String(it.name || 'object').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'object';
    for (let k = 2, base = name; names.has(name); k++) name = `${base}_${k}`;
    if (it.shape === 'cylinder') {
      const radius = num(it.radius, 0.02, 300), height = num(it.height, 0.02, 600);
      if (radius === null || height === null) continue;
      objects.push({ name, shape: 'cylinder', center, radius, height });
    } else {
      const sz = Array.isArray(it.size) ? [num(it.size[0], 0.02, 1000), num(it.size[1], 0.02, 600), num(it.size[2], 0.02, 1000)] : [null];
      if (sz.includes(null)) continue;
      objects.push({ name, shape: 'box', center, size: sz, yaw_deg: num(it.yaw_deg, -360, 360) || 0 });
    }
    names.add(name);
  }
  return { objects };
}
async function runLayout(o) {
  if (!o.image || !o.brief || !o.out) throw new Error('使い方：node paint.mjs layout --image <絵> --brief <説明の文> --out <layout.json> [--depth <奥行きの絵>] [--prev <今の layout.json> --overlay <重ねた絵> --report <見比べの文>]');
  const refine = typeof o.prev === 'string' && typeof o.overlay === 'string' && typeof o.report === 'string';
  const workDir = path.join(path.dirname(path.resolve(o.out)), 'work', `layout-${stamp()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const references = [{ name: 'picture.png', file: o.image }];
  const hasDepth = typeof o.depth === 'string';
  if (hasDepth) references.push({ name: 'depth.png', file: o.depth });
  if (refine) references.push({ name: 'overlay.png', file: o.overlay }, { name: 'layout.json', file: o.prev });
  const prompt = layoutPrompt({ brief: fs.readFileSync(o.brief, 'utf8'), hasDepth, refine, report: refine ? fs.readFileSync(o.report, 'utf8') : '' });
  console.log(`${refine ? '形の配置を直してもらいます' : '形の配置を書いてもらいます'}：${o['dry-run'] ? '文と絵を用意します（Codex は呼びません）' : 'Codex に頼んでいます'}`);
  const raw = await askJson({ workDir, prompt, references, resultName: 'layout.json', command: o.codex || 'codex', timeoutSeconds: Number(o.timeout) || 600, dryRun: !!o['dry-run'] });
  if (!raw) { console.log(`  → ${workDir}`); return; }
  const layout = cleanLayout(raw);
  if (!layout.objects.length) throw new Error(`layout.json に使える形が 1 つもありません。記録：${workDir}`);
  fs.writeFileSync(o.out, JSON.stringify(layout, null, 1));
  console.log(`  → ${o.out}（形 ${layout.objects.length} 個）`);
}

const o = parseArgs(process.argv.slice(2));
try {
  if (o._ === 'views') await runViews(o);
  else if (o._ === 'fill') await runFill(o);
  else if (o._ === 'layout') await runLayout(o);
  else if (o._ === 'repaint') await runRepaint(o);
  else { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(2); }
} catch (e) {
  console.error(`止まりました：${e.message}`);
  process.exit(1);
}
