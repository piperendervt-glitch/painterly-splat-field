# 手元の PC のモデルで穴を埋める（別視点の絵を生成するモデル／画像生成モデル）

「視点を足す」のタブの「2. 穴を埋める」には、ChatGPT（Codex）のほかに、手元の PC の GPU で動かすモデルを呼ぶ描き手が 2 つある。どちらも ChatGPT の利用枠を使わない。

| 描き手 | すること | 例 |
|---|---|---|
| 別視点の絵を生成するモデル | もとの絵と、足す視点のカメラを渡して、その視点から見た絵を作ってもらい、穴の所に使う | ViewCrafter、Stable Virtual Camera、UGG |
| PC の画像生成モデル | 穴のまわりの絵に合わせて、穴の中を描く（inpainting）。別視点の絵の「仕上げ」（粗い絵の細かさを戻す）にも使う | Stable Diffusion／SDXL の inpainting、FLUX.1 Fill |

道具はモデルそのものを持たない。決まった形のコマンドを呼ぶだけで、モデルの用意はコマンドの側にある。既定のコマンドは次のとおり（Windows では WSL 越しに呼ぶ）。別のコマンドにするときは、環境変数に入れてから道具を起動する。

| 描き手 | 既定のコマンド | 環境変数 |
|---|---|---|
| 別視点の絵を生成するモデル | `wsl -- /opt/psf-ext/nvs/run.sh` | `PSF_NVS` |
| PC の画像生成モデル | `wsl -- /opt/psf-ext/inpaint/run.sh` | `PSF_INPAINT` |

コマンドが `wsl` で始まるときは、ファイルの場所を `/mnt/c/...` の形に直して渡す。

## 別視点の絵を生成するモデルとの約束（`paint/nvs.mjs`）

```
<コマンド> <仕事.json>
```

```json
{
  "model": "（無ければコマンドの既定）",
  "source_image": "もとの絵（PNG）",
  "source_intrinsics": { "width": 1536, "height": 1016, "fx": 1330.215, "fy": 1330.215, "cx": 768, "cy": 203.2 },
  "source_depth": "もとの絵の奥行き。float32 の .npy、(高さ, 幅)、カメラの前方向の距離（m）、0 = 空",
  "targets": [{
    "name": "R1",
    "c2w": "4×4。OpenCV の向き（+x 右、+y 下、+z 前）。世界 = もとの絵のカメラ座標。平行移動は m",
    "intrinsics": { "width": 1536, "height": 1016, "fx": 1330.215, "fy": 1330.215, "cx": 768, "cy": 203.2 },
    "render": "その視点へ写した今の絵（PNG）。分からない所は真のマゼンタ #FF00FF",
    "out": "生成した絵を書く所（PNG、intrinsics と同じ大きさ）",
    "out_depth": "モデルが奥行きも出すなら書く所（.npy、m）。無くてよい"
  }],
  "style": "画風（英語の名詞句）", "hint": "穴に描く物・描かない物", "seed": 0
}
```

- 主点（cx, cy）は絵の中心とは限らない（ジャット島は地平線が上から 2 割の所）。モデルの都合で切り抜きや拡大縮小をしたら、`out` を書く前に元へ戻す
- `out` は、`render` の分かっている所と位置が合っていること。道具は穴の画素だけを `out` から取り、穴の外はもとの絵のままにする
- 終了コード 0 で成功。失敗は 0 以外と、標準エラーに理由を 1 行

道具は、できた絵を穴にはめた後、絵全体の奥行きを Depth Anything V2 Small で推定し、すでに位置の分かっている面に合わせて、穴の奥行きを決める（Codex のときと同じ）。

## 別視点のモデルの絵を下絵にして、ChatGPT（Codex）で描く

別視点のモデルは「その視点から何がどこに見えるか」は出せるが、絵が粗く、点描の画風も崩れやすい。ChatGPT の画像生成は画風に強いが、視点を言葉で指定することはできない。そこで両方を組にする：別視点のモデルの絵で視点と構図を決め、ChatGPT には、その構図のまま、もとの絵の画風で描いてもらう。プレビズの絵を下絵にして絵画化するのと同じ考え方で、下絵が 3D の絵から別視点のモデルの絵に替わっただけ。

- 画面：「2. 穴を埋める」の「別視点のモデルの絵を下絵に、Codex で描く」。連続モードでは「別視点の生成モデル＋Codex」。1 回につき、別視点のモデルを 1 回と Codex を 1 回（絵 1 枚、ChatGPT の利用枠）使う
- Codex に見せる絵は 3 枚：`holes.png`（今の絵。穴はマゼンタ）、`layout.png`（同じ視点で、穴に別視点のモデルの絵をはめた物。穴の中の物の位置と形はこれに従う）、`style.png`（もとの絵。画風・色・光の見本）
- できた絵は、穴の所だけを使う（穴の外はもとの絵のまま）。下絵は `<視点>_layout.png` に残るので、Codex だけをやり直せる

```
node paint/paint.mjs fill --image <視点>_reproj.png --mask <視点>_holes.png --out <視点>_painted.png \
     --nvs --export-dir <previz-export> --view <視点> --repaint          # 別視点のモデル → Codex
node paint/paint.mjs fill ... --layout <視点>_layout.png --export-dir <previz-export>   # 下絵はそのまま、Codex だけ
node paint/paint.mjs repaint --image <別視点の絵> --style-ref <もとの絵> --out <出す絵>   # 穴だけでなく 1 枚まるごと描き直す
```

`--dry-run` を付けると、Codex は呼ばずに、送る文と条件の絵だけを作業フォルダに作る（別視点のモデルは動く）。

## 画面を開かずに視点を足す（`painting/add-view.mjs`）

「視点を足す」のタブと同じ計算を、同じ順（写す → 穴を埋める → 埋めた絵の奥行きを合わせる）でコマンドから動かす。位置と向きは、もとの絵のカメラから見た量で指定する。

```
node painting/add-view.mjs --scene jatte --right 0.75 --fill nvscodex       # 右へ 0.75 m。別視点のモデル → Codex（Codex を 1 回使う）
node painting/add-view.mjs --scene jatte --yaw 20 --fill nvs --nvs-model seva   # その場で右へ 20°。別視点のモデルだけ（利用枠なし）
node painting/add-view.mjs --scene jatte --orbit 10 --orbit-dist 8 --fill none  # 正面 8 m の点のまわりを 10°。写すところまで
```

できた視点は R1, R2, … として `added_views.json` に加わり、「粒の空間」で「ファイルを読み直す」を押すと出る。

## PC の画像生成モデルとの約束（`paint/localinpaint.mjs`）

```
<コマンド> <穴の絵.png> <出す絵.png> <仕事.json>
```

- 穴の絵：描く所が真のマゼンタ（#FF00FF）の RGB の絵
- 出す絵：同じ大きさの PNG。穴の外は道具がもとの絵に戻すので何でもよいが、位置は 1 画素もずらさない
- 仕事.json：`{ "style", "hint", "width", "height", "model"?, "seed"?, "init"?, "strength"? }`
  - `init`（絵）があるときは仕上げ：穴の中を、その絵から `strength`（0〜1）の強さで描き直す。別視点の絵は数百画素と粗いので、形は保ったまま点描の細かさを戻すのに使う

## 流れを確かめるための、にせの描き手

モデルも GPU も無しで、呼び出しの形だけを確かめる物。穴を鏡写しで埋めるので、**絵の出来を見るための物ではない**。

```
PSF_SCENE=jatte PSF_NVS=$PWD/paint/test/fake-nvs.sh PSF_INPAINT=$PWD/paint/test/fake-inpaint.sh PAINT_CODEX=$PWD/paint/test/fake-codex.sh npx vite
```

### 物を消した背景の視点（--plate）

立つ場所を動かした視点は、もとの絵を奥行きで動かすので、人物の縁が伸びたり割れたりしやすい。物の陰に開く隙間を埋めるだけなら、もとの視点のまま「人や動物を消した背景」を描いてもらうほうが崩れない。

```
node painting/add-view.mjs --scene jatte --plate --fill codex [--plate-grow 10] [--plate-types figure] [--plate-mask 切り抜き.png] [--dry-run]
```

- もとの視点と同じカメラの視点を 1 つ足す。穴は、札が「人・動物」の所（`--plate-mask` を渡すと、その絵の白い所）を `--plate-grow` 画素ぶん広げた範囲。
- 穴には、物の後ろの背景（芝・水・遠くの木）だけを Codex に描いてもらう（絵 1 枚）。描いた所は、奥行きを推定して地面の平面に載せ、物の後ろの粒になる。
- 札は絵から自動で付けた物なので、人なのに札が付いていない所は残る。外で作った正確な切り抜きがあれば `--plate-mask` で渡す。

### 穴の奥行きだけを決め直す（--redo-depth）

```
node painting/add-view.mjs --scene jatte --redo-depth R1 [--new-depth]
```

絵は描かず、利用枠も使わない。奥行きの決め方を直したあとに、もうある視点へ反映するときに使う。

### 物ごとの 3D の点群を重ねて写す（--objcloud）

`node painting/add-view.mjs --scene <場面> --right 0.75 --objcloud scenes/<場面>/paint-out/objcloud_depth_best.ply --fill ...`

物ごとの 3D を絵の輪郭に合わせて置いた点群（`painting/objcloud.mjs` が書く ply。世界の座標で x y z、red green blue、object_id、radius〔m〕。docs/object-interaction.md）を渡すと、
点群に入っている物体は、もとの絵の画素を動かす代わりに、点群を新しい視点から見た形で写す（板ではなく、横から見た形になる）。点群に無い物体は今までどおり絵の画素を動かす。
物の後ろに開く穴は今までどおり穴として残り、--fill の描き手が埋める。点群の画素は「分かっている画素」として扱い、粒にはしない（粒の空間では、物は「物体ごとの 3D モデル」の層が受け持つ）。

### もとの絵の切り抜きを取り替える（painting/relabel.mjs）

`painting/build.mjs` の「人・動物」の切り抜きは奥行きの推定から作るので粗い（人なのに木や地面の札になる、日傘が半分だけ人になる、足もとが四角くなる）。外で作った正確な切り抜き（物ごとの番号の絵）があれば、それで札と奥行きを書き直せる。

```
node painting/relabel.mjs --scene jatte --instances instances.png --json instances.json [--dry]
```

- `instances.png` は画素ごとの物の番号（0 = 物なし。16bit の灰色か、8bit の RGB で番号 = R + G × 256）、`instances.json` は `[{ "id": 1, "class": "person" }, …]`。class に `trunk` を含む物は木の幹として扱う。
- 切り抜きの中は、物ごとに 1 枚の立った板にそろえる。奥行きは、足もとが地面に着く所（地面の平面の式）。足もとが絵の端で切れている物・ほかの物に隠れている物・小さなかけらは、今の奥行きを使う。
- 切り抜きの外で今まで「人・動物」だった所は、地面（地平線より上はまわりの背景）に戻す。
- 前の奥行き・札・cameras.json は `_v1` の名前で残す。`--dry` は表だけ出して何も書かない。
- もとの視点の形が変わるので、足した視点は入れ直す（`import-views.mjs` をやり直す、`add-view.mjs --redo-depth`）。
