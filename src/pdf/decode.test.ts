import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import {
  decodeRgba,
  isOpaqueToken,
  findQrValues,
  isBlankCandidate,
} from "./decode";

function rasterizeTokens(tokens: string[]) {
  const side = 180;
  const width = side * tokens.length;
  const data = new Uint8ClampedArray(width * side * 4).fill(255);
  tokens.forEach((token, i) => {
    const qr = QRCode.create(token, { errorCorrectionLevel: "Q" });
    const cell = 4;
    const originX = i * side + 16;
    const originY = 16;
    for (let row = 0; row < qr.modules.size; row++) {
      for (let col = 0; col < qr.modules.size; col++) {
        if (!qr.modules.get(row, col)) continue;
        for (let dy = 0; dy < cell; dy++)
          for (let dx = 0; dx < cell; dx++) {
            const offset =
              ((originY + (row + 4) * cell + dy) * width +
                originX +
                (col + 4) * cell +
                dx) *
              4;
            data[offset] = data[offset + 1] = data[offset + 2] = 0;
          }
      }
    }
  });
  return { data, width, height: side };
}

describe("actual QR pixel decoding", () => {
  it("finds both a corner QR and a central QR after a successful corner read", () => {
    const tokens = [
      "0123456789abcdef0123456789abcdef",
      "fedcba9876543210fedcba9876543210",
    ];
    const width = 800,
      height = 1100;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const [index, [left, top]] of [
      [590, 20],
      [310, 450],
    ].entries()) {
      const image = rasterizeTokens([tokens[index]]);
      for (let y = 0; y < image.height; y++)
        data.set(
          image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
          ((top + y) * width + left) * 4,
        );
    }
    const canvas = {
      width,
      height,
      getContext: () => ({
        getImageData: (x: number, y: number, w: number, h: number) => {
          const result = new Uint8ClampedArray(w * h * 4);
          for (let row = 0; row < h; row++)
            result.set(
              data.subarray(
                ((y + row) * width + x) * 4,
                ((y + row) * width + x + w) * 4,
              ),
              row * w * 4,
            );
          return { data: result };
        },
      }),
    } as unknown as HTMLCanvasElement;
    expect(findQrValues(canvas, "top-right").sort()).toEqual(tokens.sort());
  });

  it("treats white paper only as a candidate and retains faint pencil strokes", () => {
    const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(isBlankCandidate(blank)).toBe(true);
    for (let x = 50; x < 150; x++) {
      const offset = (100 * 200 + x) * 4;
      blank[offset] = blank[offset + 1] = blank[offset + 2] = 235;
    }
    expect(isBlankCandidate(blank)).toBe(false);
  });
  it("recognizes both supported token encodings without treating URLs as tokens", () => {
    expect(isOpaqueToken("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isOpaqueToken("AbCdEfGhIjKlMnOpQrSt_-")).toBe(true);
    expect(isOpaqueToken("https://example.com/12")).toBe(false);
    expect(isOpaqueToken("not a token")).toBe(false);
  });
  it("decodes an opaque token from image pixels", () => {
    const token = "aBcD0123_4567-89xyzABCD";
    const image = rasterizeTokens([token]);
    expect(decodeRgba(image.data, image.width, image.height)).toEqual([token]);
  });

  it("returns no inferred value for an empty image", () => {
    expect(
      decodeRgba(new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100),
    ).toEqual([]);
  });

  it("detects two independent QR codes for conflict review", () => {
    const tokens = ["AbCd0123456789xyZ_abcd1", "ZyXw9876543210abc-def12"];
    const image = rasterizeTokens(tokens);
    expect(decodeRgba(image.data, image.width, image.height).sort()).toEqual(
      tokens.sort(),
    );
  });
});
