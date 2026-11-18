// 種類の一覧。粒の「種類の札」と、プレビズが書き出す「種類の絵」の画素値はここの id。
// 増やすときは末尾に行を足す。書き出し済みのデータが指している番号は変えない。
//   sway   : 風やプレイヤーで揺れる度合い（0 = 揺れない、1 = よく揺れる）
//   light  : 'sun' = 太陽と空の光を受ける、'sky' = 空そのもの（時間帯の色だけ掛ける）、'self' = 自分で光る（暗くしない）
//   snow   : 雪が積もる面になりうる
//   water  : 水面（照り返しを付ける対象）
//   color  : 「種類で色分け」表示の色
//   tracks : 歩くと足跡が残る
//   layer  : 'back' = 背景（地面・水・遠景・空）、'front' = 手前の物（人・木・建物）。手前の物の後ろに、背景を伸ばした層を作る（studio/layers.js）
//   solid  : 歩くときの当たり。'walk' = 上に立てて横からはぶつかる、'wall' = ぶつかるが上には立てない、'none' = すり抜ける
export const TYPES = [
  { id: 0, key: 'sky',    name: '空',     color: '#7fb2ea', sway: 0, light: 'sky',  snow: false, water: false, solid: 'none', tracks: false, layer: 'back'  },
  { id: 1, key: 'ground', name: '地面',   color: '#b0763c', sway: 0, light: 'sun',  snow: true,  water: false, solid: 'walk', tracks: true , layer: 'back'  },
  { id: 2, key: 'grass',  name: '草地',   color: '#63c132', sway: 1, light: 'sun',  snow: true,  water: false, solid: 'walk', tracks: true , layer: 'back'  },
  { id: 3, key: 'stone',  name: '石壁',   color: '#d9d2c0', sway: 0, light: 'sun',  snow: true,  water: false, solid: 'walk', tracks: false, layer: 'front' },
  { id: 4, key: 'trunk',  name: '木の幹', color: '#7a4a21', sway: 0, light: 'sun',  snow: false, water: false, solid: 'walk', tracks: false, layer: 'front' },
  { id: 5, key: 'leaves', name: '木の葉', color: '#1f8a4c', sway: 1, light: 'sun',  snow: true,  water: false, solid: 'none', tracks: false, layer: 'front' },
  { id: 6, key: 'water',  name: '水',     color: '#2a6fdb', sway: 0, light: 'sun',  snow: false, water: true, solid: 'wall', tracks: false, layer: 'back'  },
  { id: 7, key: 'lamp',   name: '灯り',   color: '#ffd23f', sway: 0, light: 'self', snow: false, water: false, solid: 'walk', tracks: false, layer: 'front' },
  // 実在の絵から作った場面（painting/build.mjs）で使う種類
  { id: 8, key: 'figure', name: '人・動物', color: '#e0607a', sway: 0, light: 'sun',  snow: false, water: false, solid: 'wall', tracks: false, layer: 'front' },
  { id: 9, key: 'far',    name: '遠景',   color: '#8f9bb8', sway: 0, light: 'sun',  snow: false, water: false, solid: 'none', tracks: false, layer: 'back'  },
];

export const SKY_TYPE = 0;
export const typeByKey = (key) => {
  const t = TYPES.find((x) => x.key === key);
  if (!t) throw new Error(`種類 "${key}" は shared/labels.js の一覧にありません`);
  return t;
};
export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// 物体の色分け表示の色。番号から決まる、隣どうしが似ない色。0（物体なし）は灰色。
export function objectColor(id) {
  if (!id) return [70, 74, 78];
  const h = (id * 0.61803398875) % 1, s = 0.62, v = 0.95;
  const f = (n) => { const k = (n + h * 6) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}
