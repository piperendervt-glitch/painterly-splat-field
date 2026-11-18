# paint：プレビズを下絵に、ChatGPT で絵画的な絵を作る

ChatGPT の月額プランの中で絵を作ります。API キー（従量課金）は使いません。
呼び方は game-studio と同じで、OpenAI の Codex CLI（`codex exec`）の組み込みの画像生成を、`OPENAI_API_KEY` を外して呼びます。

## 準備（初回だけ）

```
npm install -g @openai/codex
codex login          # ChatGPT のアカウントで
cd paint
npm install
```

## 視点の絵を作る（段 2）

プレビズの書き出し（`cameras.json` と各視点の `*_color.png`・`*_depth_view.png`）を下絵にします。

```
node paint.mjs views --in ../previz-export --out out
```

- 各視点で、プレビズの色の絵と奥行きの絵を Codex に見せ、同じ構図のまま絵画にしてもらいます。
- 2 枚目からは、1 枚目にできた絵も「画風の見本」として見せます（視点ごとに画風がばらつかないように）。
- 出るもの：`out/A_painted.png`（`cameras.json` の大きさに合わせたもの）、`out/A_overlay.png`（プレビズの輪郭をシアンで重ねた確かめ用）、`out/paint_report.json`
- 画風を変える：`--style "watercolor with soft edges"`。一部の視点だけ：`--views A`
- 光の描かせ方：`--light flat` は光の少ない絵（曇り空の均一な光、落ちる影なし。下絵は `*_flat.png`、出るものは `out/A_painted_flat.png`）。`--light previz` はプレビズの光に従う絵（下絵 `*_lit.png` の日なた・日陰・影を守らせる。出るものは `out/A_painted_lit.png`）。付けなければ今までどおり光は任せる。粒の光を後から付け替えるための描き分け。
- 1 枚 30 秒〜数分。1 枚ずつ順番に作ります（Codex は同時に 2 つ動かすと壊れることがあるため）。

**判断の目安**：`*_overlay.png` で、シアンの線が絵の形の境目に乗っていれば、そのまま粒にできます。ずれていれば、生成の絵はそのままでは使えません（構図が保たれない）。

## 穴だけ描き足す（段 4 用）

```
node paint.mjs fill --image <絵> --mask <穴の印。白が穴> --out out/filled.png
```

- 穴をマゼンタで塗った絵を見せて「マゼンタの所だけ描いて」と頼み、できた絵の **穴の所だけ** を元の絵に貼ります。穴の外は 1 画素も変えません。
- Codex の画像生成には、マスクを厳密に渡す口が無いので、この形にしています。Codex が絵全体を少しずらして描き直すと、継ぎ目が出ます。そのときは「穴の外の変わり具合」の数が大きく出ます。

### 手前の物を消した背景の絵（背後の層の色）

```
node paint.mjs fill --plate --image <絵> --mask <手前の物とその縁。白が穴> --guide <穴を計算で埋めた絵> --out out/A_plate_painted.png --grow 0
```

- `--plate` を付けると、穴は「手前の物があった所」として頼みます：その後ろにある背景（地面・水・遠景・空）だけを描かせ、人や木や建物は描かせません。
- `--guide` は、どこに何の背景が来るかの目安の絵です。

### 形の配置を書いてもらう（絵は作らない）

```
node paint.mjs layout --image <絵> --depth <奥行きの絵> --brief <カメラと奥行きの表の文> --out out/layout_ai.json
node paint.mjs layout --image <絵> --brief <文> --prev out/layout_ai.json --overlay <今の形を絵に重ねた絵> --report <見比べの文> --out out/layout_ai.json
```

- 場面の物を、箱と円柱の一覧（`{ "objects": [...] }`）に書いてもらいます。座標は、カメラの真下の地面が原点、+x = 絵の右、+y = 上、+z = 奥（m）。
- 2 つ目の形は「直し」の回です。今の配置・それを絵に線で重ねた絵・見比べの文を渡して、全部を書き直してもらいます。
- 読めない形は捨て、名前や大きさを決まった範囲に整えてから保存します。GUI の「AI に形の配置を書かせる」が、説明の文と見比べの文を作ってこれを呼びます。

### 周囲の地面（絵の外の地面）

```
node paint.mjs fill --ground --image <30° 見下ろした地面の絵> --mask <白が穴> --guide <穴を計算で埋めた絵> --style-ref <場面の絵> --out out/ground_face0_painted.png
```

- `--ground` を付けると、「人や木や物の無い、地面だけ」を、穴の所に描かせます。上の帯（地平線より上）は仮の色で、描かせません。
- GUI の「周囲の地面（絵の外）」の「周囲の地面を AI に描いてもらう」が、4 つの向きについてこれを順に呼びます。
- ふだんは「粒の空間」の「背後の層を AI に描いてもらう」から呼びます（視点ごとに 1 枚。絵と穴の印はそこで作ります）。考え方は `docs/angle-artifacts.md` の 3b。

## 利用枠を使わずに確かめる

- `--dry-run`：Codex を呼ばず、送る文（`out/work/<日時>/<視点>/prompt.txt`）と条件の絵だけを作ります。
- `npm test`：にせの codex で流れを確かめます。

## 確かめていないこと

- 本物の Codex CLI での生成（この開発環境には Codex もログインも無いため）。うまくいかないときは `out/work/<日時>/<視点>/codex-output.txt` に Codex の出力が残ります。
