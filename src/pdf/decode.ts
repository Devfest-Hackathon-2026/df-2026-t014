import jsQR from "jsqr";
import type { QrCorner } from "../domain/types";

/** Current generator uses 128-bit hexadecimal tokens; accept the design's
 * base64url encoding too so unknown PaperFlow-looking codes can be isolated. */
export function isOpaqueToken(value: string): boolean {
  return /^[a-fA-F0-9]{32}$/.test(value) || /^[A-Za-z0-9_-]{22}$/.test(value);
}

/** Decode actual pixels. No PDF metadata or hidden token text is used. */
export function decodeRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  allowSplit = true,
): string[] {
  const copy = new Uint8ClampedArray(data);
  const values = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    const result = jsQR(copy, width, height, {
      inversionAttempts: "attemptBoth",
    });
    if (!result) break;
    values.add(result.data);
    const points = [
      result.location.topLeftCorner,
      result.location.topRightCorner,
      result.location.bottomLeftCorner,
      result.location.bottomRightCorner,
    ];
    const minX = Math.max(
      0,
      Math.floor(Math.min(...points.map((point) => point.x)) - 8),
    );
    const maxX = Math.min(
      width - 1,
      Math.ceil(Math.max(...points.map((point) => point.x)) + 8),
    );
    const minY = Math.max(
      0,
      Math.floor(Math.min(...points.map((point) => point.y)) - 8),
    );
    const maxY = Math.min(
      height - 1,
      Math.ceil(Math.max(...points.map((point) => point.y)) + 8),
    );
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const offset = (y * width + x) * 4;
        copy[offset] =
          copy[offset + 1] =
          copy[offset + 2] =
          copy[offset + 3] =
            255;
      }
    }
  }
  // Adjacent codes can confuse a detector's finder-pattern selection. Try
  // overlapping halves once, retaining full resolution, before declaring unreadable.
  if (!values.size && allowSplit && Math.max(width, height) >= 120) {
    const windows = [
      { x: 0, y: 0, w: Math.ceil(width * 0.56), h: height },
      {
        x: Math.floor(width * 0.44),
        y: 0,
        w: width - Math.floor(width * 0.44),
        h: height,
      },
      { x: 0, y: 0, w: width, h: Math.ceil(height * 0.56) },
      {
        x: 0,
        y: Math.floor(height * 0.44),
        w: width,
        h: height - Math.floor(height * 0.44),
      },
    ];
    for (const box of windows) {
      const part = new Uint8ClampedArray(box.w * box.h * 4);
      for (let y = 0; y < box.h; y++) {
        const start = ((box.y + y) * width + box.x) * 4;
        part.set(data.subarray(start, start + box.w * 4), y * box.w * 4);
      }
      for (const value of decodeRgba(part, box.w, box.h, false))
        values.add(value);
    }
  }
  return [...values];
}

export function findQrValues(
  canvas: HTMLCanvasElement,
  preferredCorner: QrCorner = "top-right",
): string[] {
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const width = canvas.width;
  const height = canvas.height;
  const cropW = Math.ceil(width * 0.4);
  const cropH = Math.ceil(height * 0.35);
  const found = new Set<string>();
  const locations: Record<QrCorner, [number, number]> = {
    "top-right": [width - cropW, 0],
    "top-left": [0, 0],
    "bottom-right": [width - cropW, height - cropH],
    "bottom-left": [0, height - cropH],
  };
  const corners = [
    preferredCorner,
    ...Object.keys(locations).filter((corner) => corner !== preferredCorner),
  ] as QrCorner[];
  const crops = corners.map((corner) => locations[corner]);
  for (const [x, y] of crops) {
    const image = context.getImageData(x, y, cropW, cropH);
    for (const value of decodeRgba(image.data, cropW, cropH)) found.add(value);
  }
  // Corner success is not proof that the page contains only one code. Scan the
  // central area and full page too, so a corner+center conflict stays unresolved.
  const middleY = Math.floor(height * 0.25);
  const middle = context.getImageData(0, middleY, width, height - middleY * 2);
  for (const value of decodeRgba(middle.data, width, height - middleY * 2))
    found.add(value);
  const image = context.getImageData(0, 0, width, height);
  for (const value of decodeRgba(image.data, width, height)) found.add(value);
  return [...found];
}

/** Conservative candidate only: callers must keep it pending for human review. */
export function isBlankCandidate(data: Uint8ClampedArray): boolean {
  let marked = 0;
  const threshold = Math.max(2, Math.floor((data.length / 4) * 0.00001));
  for (let index = 0; index < data.length; index += 4) {
    const luminance =
      0.2126 * data[index] +
      0.7152 * data[index + 1] +
      0.0722 * data[index + 2];
    if (data[index + 3] > 16 && luminance < 248 && ++marked > threshold)
      return false;
  }
  return true;
}
