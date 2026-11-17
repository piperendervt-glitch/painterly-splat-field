// 奥行きの符号化。試作ビューアと同じく 16bit を PNG の R（上位）G（下位）に入れる。
// 値は視差（距離の逆数）を near〜far で 0〜1 に正規化したもの。1 が最も手前、0 が far 以遠（空）。
//   d = (1/z - 1/far) / (1/near - 1/far)      z はカメラの向きに沿った距離（m）。視線に沿った距離ではない。
//   z = 1 / (d * (1/near - 1/far) + 1/far)
export const DEPTH_FORMULA = {
  encoding: 'normalized_inverse_z_uint16',
  png: 'value = R * 256 + G (B is unused), d = value / 65535',
  d_from_z: 'd = (1/z - 1/far) / (1/near - 1/far)',
  z_from_d: 'z = 1 / (d * (1/near - 1/far) + 1/far)',
  z_meaning: 'distance along the camera forward axis in meters (not ray length)',
  background: 'value 0 = sky / nothing rendered',
};

export function zFromValue(value, near, far) {
  const d = value / 65535;
  return 1 / (d * (1 / near - 1 / far) + 1 / far);
}
