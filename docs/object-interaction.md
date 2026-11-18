# 絵の中の物を切り出して、持つ・動かす・消す

Niantic Spatial の Object Interaction（撮影した 3D 空間から動かせる物を見つけ、見た目を保って切り出し、当たりと簡易な物理を付けて、選ぶ・動かす・消すができる機能）と同じことを、絵 1 枚から作った場面でできるようにする。Niantic の機能そのものはコードも論文も公開されていないので、公開されている道具で組む。検討の記録は、プロジェクトの design/object_interaction_for_jatte.md。

## 流れ

| 段 | すること | 道具 | 動く所 |
|---|---|---|---|
| 1 | 絵の中の物を、言葉で指定して 1 つずつ切り抜く | SAM 3（Meta、SAM License） | 手元の PC の WSL |
| 2 | 切り抜きで物体を作り直した場面の版を足す（今の版は消さない） | painting/build.mjs --masks --variant sam3 | ツール |
| 3 | 物の隠れた所（手前の物の後ろ、絵の端の外）を描き足した「全身の絵」を作る（任意） | Codex（ChatGPT の利用枠。物 1 つにつき 1 回） | ツール |
| 4 | 物ごとに 3D を作る | TRELLIS（MIT）／Hunyuan3D 2.1（Tencent Hunyuan 3D 2.1 Community License）／SAM 3D Objects（SAM License） | 手元の PC の WSL |
| 5 | 3D を絵の物の輪郭に合わせて置き、粒にする | studio/objectmodel.js（.glb のメッシュも .ply の 3D の粒も） | ツール |
| 6 | 歩く画面で、物を持つ・投げる・消す・戻す。重力とぶつかり | studio/interact.js、studio/physics.js（Rapier、Apache-2.0） | ツール |

物を消した後ろには、背後の層（layers.js。AI が描いた背景の絵があればその色）が見える。

## 画面（粒の空間の「物を切り出して動かす」）

- **物の切り分け**：「奥行きで分けた（今まで）」と「SAM 3 で切り抜いた」を切り替えて見比べる。表示「物体」で物ごとの色分けが見える
- **SAM 3 で切り抜き直す**：切り抜く物の名前（英語、カンマ区切り）を変えて、やり直せる
- **物の 3D の作り方**：手で選んだモデル／TRELLIS／Hunyuan3D／SAM 3D Objects を切り替えて見比べる。作った 3D は作り方ごとに残る
- **歩く画面で動かす**：画面のまん中で見ている物が黄色く光る。F 持つ・放す（ホイールで距離）、G 投げる、X 消す、Z 消した物を 1 つ戻す、R 全部戻す。40 kg より軽い物は体で押せる。重い物は当たりで止まり、上に乗れる

## 外の道具との約束

ツールはモデルそのものを持たない。決まった形のコマンドを呼ぶだけ。Windows では WSL 越しに呼び、仕事.json の中の場所は `/mnt/c/...` の形に直して渡す。

| 道具 | 既定のコマンド | 環境変数 |
|---|---|---|
| 物の切り抜き | `wsl -- /opt/psf-ext/sam3/run.sh` | `PSF_SEG` |
| 物の 3D | `wsl -- /opt/psf-ext/obj3d/run.sh` | `PSF_OBJ3D` |

どちらも `<コマンド> <仕事.json>`。終了コード 0 で成功。失敗は 0 以外と、標準エラーに理由を 1 行。

### 物の切り抜き（paint/objects.mjs segment）

```json
{ "image": "…/paint-out/J_painted.png", "out_dir": "…/paint-out/work/seg-sam3", "prompts": ["person", "dog"], "threshold": 0.5 }
```

out_dir に書くもの：

```json
{ "width": 1536, "height": 1016, "instances": [ { "label": "person", "score": 0.93, "bbox": [x0, y0, x1, y1], "mask": "mask_000.png" } ] }
```

mask は絵と同じ大きさの 8 ビットの白黒の絵（白 = 物）。重なりの整理（同じ物の重複、帽子が人の中にある、など）は painting/masks.mjs がする。

### 物の 3D（paint/objects.mjs make3d）

```json
{ "method": "trellis | hunyuan3d | sam3d", "image": "絵（全体）", "mask": "その物の印（絵と同じ大きさ）",
  "cutout": "物だけの RGBA の絵（外は透明。描き足した全身の絵のときは大きさが違う）", "cutout_is_completed": false,
  "out_dir": "…", "seed": 0, "texture": false }
```

out_dir に書くもの：`model.glb`（メッシュ）と／または `model.ply`（3D Gaussian Splatting の形：x y z、f_dc_0..2、opacity、scale_0..2、rot_0..3）、`info.json`（`{ method, seconds, peak_vram_gb, files, pose? }`）。ツールは paint-out に `obj3d_<切り分けの版>_<作り方>_<番号>.glb / .ply / .json` として写す。

モデルの向き・大きさ・位置は、絵の物の輪郭にいちばん重なるように探す（objectmodel.js の fitModel。.ply と .obj は +Y 上・+Z 上の両方を試す）。

## 流れを確かめるための、にせの道具

本物のモデルが無くても流れを試せる（結果は本物ではない）。

```
set PSF_SEG=node paint/test/fake-sam3.mjs
set PSF_OBJ3D=node paint/test/fake-obj3d.mjs
```

- fake-sam3：今の物体の絵の大きい物を 6 個と、四角い「umbrella」を 1 個、切り抜きとして書く
- fake-obj3d：切り抜きの色で塗った、だ円体の 3D の粒（trellis・sam3d）か箱（hunyuan3d）を書く

## 知られている限り

- 絵に描かれた影は地面の粒に焼き付いているので、物を動かしても影は元の所に残る
- 重さは種類と大きさからの見積もり（Niantic と同じく、詳しい物理の代わりではない）
- 物理の当たりの形は物の粒の凸包（へこみは無い）。歩く人の当たりは、重い物は箱
- 触って揺らす（studio/jiggle.js）は粒の元の場所で計算するので、動かした物は元の場所を触ったときに揺れる
- 3D の作り方はどれも写真や CG で学んだモデルなので、点描の人物の裏側の色は写真寄りになりうる。見えている側の色は絵から写す（objectmodel.js の modelSplats）
