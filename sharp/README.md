# sharp/ SHARP で絵 1 枚から粒を作る

Apple の [SHARP](https://github.com/apple/ml-sharp)（Sharp Monocular View Synthesis in Less Than a Second）で、絵 1 枚から 3D ガウシアンを推定し、「粒の空間」に読み込める `.ply` にする。今の「奥行きの絵から 1 画素 1 粒」の置き方と、GUI で切り替えて見比べられる。

## ライセンス（先に読む）

- **学習済みモデル（重み）は Apple Machine Learning Research Model License**。研究目的（非商用の実験・分析）に限る。製品開発や商用のサービス・作品には使えない。モデルから作った物（Model Derivatives）にも同じ制限がかかる。
- ml-sharp のコードは Apple のサンプルコードのライセンス（改変・再配布できる）。
- このリポジトリにはモデルも、モデルが出した `.ply` も入れない（`*_sharp.ply` は `.gitignore` 済み）。モデルは `setup.bat` が Apple の配布元（`ml-site.cdn-apple.com`）から取る。

## 使い方（Windows）

1. `sharp\setup.bat` をダブルクリック（初回だけ）。Python 3.10〜3.13 が要る。仮想環境 `sharp\.venv` を作り、PyTorch（NVIDIA の GPU があれば CUDA 版）、ml-sharp、モデル（約 2.8 GB）を入れる。
2. `sharp\run-jatte.bat` をダブルクリック。グランド・ジャット島の絵（`scenes\jatte\paint-out\J_painted.png`）から `scenes\jatte\paint-out\J_sharp.ply` を作る（約 120 万粒、70 MB 前後）。GPU なら数秒〜十数秒、CPU だと数分。
3. `start-jatte.bat` で GUI を開き、「粒の空間」で「ファイルを読み直す」。「粒の置き方」で「奥行きの絵から / SHARP / 両方を重ねる」を切り替える。

`start.bat` の場面（プレビズから作った絵）で試すときは `sharp\run.bat`（最初の視点）や `sharp\run.bat --view B`。出力は `paint\out\<視点>_sharp.ply`。

手で動かすとき：

```
sharp\.venv\Scripts\python.exe sharp\psf_sharp.py --scene jatte --view J [--image 別の絵.png] [--device cpu]
```

## `psf_sharp.py` がしていること

SHARP の CLI（`sharp predict`）とは次が違う。

| | `sharp predict` | `psf_sharp.py` |
| --- | --- | --- |
| 焦点距離 | 写真の EXIF（無ければ 35 mm 判で 30 mm と仮定） | `cameras.json` の `fx` |
| 光学中心 | 画像の中央 | `cameras.json` の `cx`, `cy`（場面によっては地平線の行で、中央ではない） |
| 座標 | OpenCV のカメラ座標（x 右・y 下・z 前） | この道具の世界座標（+Y 上。`camera_to_world` を掛ける。形の向きも一緒に回す） |
| 色 | sRGB（f_dc） | 同じ |

つまり、SHARP の粒を `cameras.json` のカメラから見ると、元の絵の画素と同じ所に来る。

## 「粒の空間」での扱い（`studio/sharp.js`）

- 色は SHARP が出した色。不透明さも SHARP の値（新しい列 `opacity`）。
- 形：SHARP のガウシアンは細長い楕円体だが、この道具の粒は丸いので、大きい 2 軸の幾何平均を粒の広がりにする。面の向き（`normal`）は、いちばん薄い軸をカメラ側へ向けたもの。
- 札（種類・物体）：粒を視点へ映した画素の札を取る。粒の奥行きが奥行きの絵と合わない（手前の物の後ろに SHARP が描き足した 2 層目）ときは、同じ行の左右 64 画素の中で奥行きが合う画素の札を使う。映した画素が空なら空の粒。
- 大きさ：SHARP の奥行き（メートル）と、場面の奥行きの絵（目の高さ 1.7 m から決めたもの）は尺度が少し違う。「SHARP の大きさを奥行きの絵に合わせる」を入れると、両者の比の中央値でカメラを中心に伸び縮みさせる（元の視点からの見た目は変わらない）。倍率は画面に出る。
- 視点の札：SHARP の粒は「視点の数 + 何番目か」。「視点別」の表示で色が分かれ、「使う視点」で SHARP の粒だけを出せる。
- 「視点を足す」の穴埋めは、今は奥行きの絵からの粒をもとに穴を探す。SHARP の粒を穴埋めの元にするのは次の段。
