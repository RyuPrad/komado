// Sharp metadata reports stored dimensions, before EXIF rotation/mirroring.
export function orientedSize({ width = 1, height = 1, orientation } = {}) {
  return orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}
