"""Apple の SHARP で、絵 1 枚から 3D ガウシアン（粒）を作り、この道具の世界座標で書き出す。

    python psf_sharp.py --scene jatte                 # scenes/jatte の視点 J
    python psf_sharp.py                               # previz-export/ と paint/out/ の最初の視点
    python psf_sharp.py --scene jatte --view J --image my.png --device cpu
    python psf_sharp.py --scene jatte --view J --plate painted   # 手前の物を消した背景の絵（J_plate_painted.png）を通す

入力：<previz-export>/cameras.json の視点（画像の大きさ・焦点距離・光学中心・camera_to_world）と、
      <paint-out>/<視点>_painted.png（--image で別の絵も可。視点の大きさに合わせて伸ばす）。
出力：<paint-out>/<視点>_sharp.ply（3DGS の標準の列 x y z f_dc_0-2 opacity scale_0-2 rot_0-3。色は sRGB）。

SHARP の CLI（sharp predict）との違い：
  - 焦点距離は写真の EXIF ではなく cameras.json の値を使う（絵には EXIF が無く、CLI は 30 mm と仮定してしまう）
  - 光学中心も cameras.json の値（この道具の場面は地平線の行を光学中心にしていて、画像の中央ではない）
  - 粒を OpenCV のカメラ座標から、この道具の世界座標（+Y が上、カメラは -Z を向く）へ動かしてから書き出す。
    形（共分散）も一緒に回すので、ほかの 3DGS ビューアでもそのまま開ける

SHARP の学習済みモデルは Apple Machine Learning Research Model License（研究目的のみ・非商用）。
このスクリプトはモデルを含まず、初回に Apple の配布元から取得する。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from sharp.models import PredictorParams, create_predictor
from sharp.utils.gaussians import apply_transform, save_ply, unproject_gaussians

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MODEL_URL = "https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt"
MODEL_FILE = HERE / "models" / "sharp_2572gikvuh.pt"
INTERNAL = 1536  # SHARP は 1536 × 1536 に伸ばして推論する（縦横比は焦点距離と光学中心で戻す）


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="SHARP で絵 1 枚から粒（3DGS の .ply）を作る")
    p.add_argument("--scene", default="", help="scenes/<名前> を使う（空なら previz-export/ と paint/out/）")
    p.add_argument("--view", default="", help="視点の名前（既定：cameras.json の最初の視点）")
    p.add_argument("--image", default="", help="絵のファイル（既定：<paint-out>/<視点>_painted.png）")
    p.add_argument("--plate", default="", help="手前の物を消した背景の絵（<視点>_plate_<色のもと>.png）を通す。値は色のもとの名前（例：painted）。出力は <視点>_plate_<色のもと>_sharp.ply")
    p.add_argument("--out", default="", help="書き出す .ply（既定：<paint-out>/<視点>_sharp.ply）")
    p.add_argument("--checkpoint", default=str(MODEL_FILE), help="学習済みモデル（無ければ取得する）")
    p.add_argument("--device", default="auto", help="auto / cuda / cpu / mps")
    return p.parse_args()


def scene_dirs(scene: str) -> tuple[Path, Path]:
    if scene:
        return ROOT / "scenes" / scene / "previz-export", ROOT / "scenes" / scene / "paint-out"
    return ROOT / "previz-export", ROOT / "paint" / "out"


def pick_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch, "mps", None) and torch.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def load_state_dict(path: Path) -> dict:
    if path.exists():
        print(f"モデルを読みます：{path}")
        return torch.load(path, map_location="cpu", weights_only=True)
    print(f"モデルが無いので取得します（約 2.8 GB、初回のみ）：{MODEL_URL}")
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.hub.download_url_to_file(MODEL_URL, str(path), progress=True)
    return torch.load(path, map_location="cpu", weights_only=True)


def cv_camera_to_world(view: dict) -> torch.Tensor:
    """OpenCV のカメラ座標（x 右・y 下・z 前）から、この道具の世界座標への 3 × 4 の変換。"""
    c2w = torch.tensor(view["extrinsics"]["camera_to_world"], dtype=torch.float64)  # three.js のカメラ（y 上・-z 前）→ 世界
    flip = torch.diag(torch.tensor([1.0, -1.0, -1.0, 1.0], dtype=torch.float64))  # OpenCV → three.js のカメラ
    return (c2w @ flip)[:3].float()


def intrinsics_4x4(view: dict) -> torch.Tensor:
    k = view["intrinsics"]
    return torch.tensor(
        [[k["fx"], 0, k["cx"], 0], [0, k["fy"], k["cy"], 0], [0, 0, 1, 0], [0, 0, 0, 1]],
        dtype=torch.float32,
    )


@torch.no_grad()
def predict(predictor, image: np.ndarray, view: dict, device: torch.device):
    """SHARP の predict_image と同じ手順。ただし焦点距離と光学中心は cameras.json の値を使う。"""
    H, W = image.shape[:2]
    fx = float(view["intrinsics"]["fx"])
    image_pt = torch.from_numpy(image.copy()).float().to(device).permute(2, 0, 1) / 255.0
    disparity_factor = torch.tensor([fx / W]).float().to(device)
    resized = F.interpolate(image_pt[None], size=(INTERNAL, INTERNAL), mode="bilinear", align_corners=True)
    gaussians_ndc = predictor(resized, disparity_factor)
    K = intrinsics_4x4(view).to(device)
    K[0] *= INTERNAL / W
    K[1] *= INTERNAL / H
    return unproject_gaussians(gaussians_ndc, torch.eye(4, device=device), K, (INTERNAL, INTERNAL))


def main() -> int:
    a = parse_args()
    previz_dir, paint_dir = scene_dirs(a.scene)
    cams_file = previz_dir / "cameras.json"
    if not cams_file.exists():
        print(f"{cams_file} がありません。--scene を確かめてください。", file=sys.stderr)
        return 1
    cams = json.loads(cams_file.read_text(encoding="utf-8"))
    views = cams["views"]
    view = next((v for v in views if v["name"] == a.view), None) if a.view else views[0]
    if view is None:
        print(f"視点 {a.view} が cameras.json にありません（あるのは {', '.join(v['name'] for v in views)}）", file=sys.stderr)
        return 1
    W, H, name = int(view["width"]), int(view["height"]), view["name"]
    stem = f"{name}_plate_{a.plate}" if a.plate else name  # --plate：背景の絵を通す（背後の層の奥行き用）
    image_file = Path(a.image) if a.image else paint_dir / (f"{stem}.png" if a.plate else f"{name}_painted.png")
    if not image_file.exists():
        print(f"絵 {image_file} がありません。", file=sys.stderr)
        return 1
    img = Image.open(image_file).convert("RGB")
    if img.size != (W, H):
        print(f"絵の大きさ {img.size[0]}x{img.size[1]} を視点の大きさ {W}x{H} に合わせます")
        img = img.resize((W, H), Image.BICUBIC)
    image = np.asarray(img)
    out_file = Path(a.out) if a.out else paint_dir / f"{stem}_sharp.ply"

    device = pick_device(a.device)
    print(f"視点 {name}（{W}x{H}、fx {view['intrinsics']['fx']:.1f}）、絵 {image_file.name}、計算 {device}")
    t0 = time.time()
    predictor = create_predictor(PredictorParams())
    predictor.load_state_dict(load_state_dict(Path(a.checkpoint)))
    predictor.eval().to(device)
    t1 = time.time()
    print(f"モデルの準備 {t1 - t0:.1f} 秒。推論します…")
    gaussians = predict(predictor, image, view, device)
    t2 = time.time()
    world = apply_transform(gaussians, cv_camera_to_world(view).to(device))
    n = world.mean_vectors.shape[1]
    print(f"推論 {t2 - t1:.1f} 秒、粒 {n:,} 個。書き出します…")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    save_ply(world, float(view["intrinsics"]["fx"]), (H, W), out_file)
    print(f"書き出しました：{out_file}（{out_file.stat().st_size / 1e6:.0f} MB、{time.time() - t2:.1f} 秒）")
    if a.plate:
        print("GUI の「粒の空間」で「ファイルを読み直す」を押すと、背後の層の位置にこの奥行きが使われます。")
    else:
        print("GUI の「粒の空間」で「ファイルを読み直す」を押し、「粒の置き方」で SHARP を選んでください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
