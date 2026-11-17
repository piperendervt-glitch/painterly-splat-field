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
- 1 枚 30 秒〜数分。1 枚ずつ順番に作ります（Codex は同時に 2 つ動かすと壊れることがあるため）。

**判断の目安**：`*_overlay.png` で、シアンの線が絵の形の境目に乗っていれば、そのまま粒にできます。ずれていれば、生成の絵はそのままでは使えません（構図が保たれない）。

## 穴だけ描き足す（段 4 用）

```
node paint.mjs fill --image <絵> --mask <穴の印。白が穴> --out out/filled.png
```

- 穴をマゼンタで塗った絵を見せて「マゼンタの所だけ描いて」と頼み、できた絵の **穴の所だけ** を元の絵に貼ります。穴の外は 1 画素も変えません。
- Codex の画像生成には、マスクを厳密に渡す口が無いので、この形にしています。Codex が絵全体を少しずらして描き直すと、継ぎ目が出ます。そのときは「穴の外の変わり具合」の数が大きく出ます。

## 利用枠を使わずに確かめる

- `--dry-run`：Codex を呼ばず、送る文（`out/work/<日時>/<視点>/prompt.txt`）と条件の絵だけを作ります。
- `npm test`：にせの codex で流れを確かめます。

## 確かめていないこと

- 本物の Codex CLI での生成（この開発環境には Codex もログインも無いため）。うまくいかないときは `out/work/<日時>/<視点>/codex-output.txt` に Codex の出力が残ります。
