# painterly-splat-field

AI が生成した絵画的な 2D 画像から、ガウシアンの粒でできた絵画的な 3D 空間（three.js / WebGPU）を作り、歩いて探索できるようにするツール。

## 動かし方

```
npm install
npm run dev
```

表示された URL を Chrome か Edge で開く。

## previz/ プレビズ書き出し

地面・アーチ1つ・奥の塔だけの下絵用シーン（`previz/scene.js`）。2つの視点（カメラA・B）から次を zip で書き出す。

| ファイル | 中身 |
| --- | --- |
| `A_color.png` `B_color.png` | 色（1024×1536） |
| `A_depth.png` `B_depth.png` | 奥行き。16bit を R（上位）G（下位）に格納 |
| `A_depth_view.png` `B_depth_view.png` | 目で見る用の奥行き（明るいほど手前、距離の対数） |
| `cameras.json` | 内部・外部パラメータと奥行きの式 |

奥行きは視差を正規化した値で、`d = value / 65535`、`z = 1 / (d * (1/near - 1/far) + 1/far)`。`z` はカメラの向きに沿った距離（m）。値 0 は空。座標系と行列の向きは `cameras.json` に書いてある。

デバッグ表示：

- 視点：俯瞰 / カメラA / カメラB
- 表示：色 / 奥行き
- カメラの視錐台（橙が A、水色が B）
- 書き出したデータだけから復元した点群（A＋B / A だけ / B だけ）。形を隠して「Aの点だけ」をカメラBから見ると、A から見えなかった裏側の穴が分かる。
- 描画方式（WebGPU / WebGL 2）の切り替えと fps
- 復元の誤差：書き出した奥行きを、形への当たり判定で求めた距離と比べた相対誤差

視点や大きさを変えるときは `previz/scene.js` の `EXPORT` を編集する。

## prototype/ 粒の絵画ビューア（試作）

1枚の絵を奥行き推定で粒に変換して覗き込む最初の試作。素材の `painting.jpg` と `depth.png` は参考の絵そのものなので、このリポジトリには入れていない（`.gitignore` 済み）。手元で試すときだけ `prototype/` に置く。
