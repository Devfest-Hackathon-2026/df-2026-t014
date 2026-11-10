import { describe, expect, it } from "vitest";
import {
  A4,
  MANAGEMENT_BAND,
  qrBox,
  sourceTransform,
  normalizedSourcePlacement,
  printLayoutMetrics,
  reservedArea,
  printManifest,
} from "./geometry";
import type { QrCorner } from "../domain/types";
import { createCollection } from "../domain/logic";

describe("QR reserved area", () => {
  it("honors the fixed issued order when additional recipients are appended", () => {
    const students = [0, 1, 2].map((index) => ({
      id: String(index),
      name: `生徒${index}`,
      number: index + 1,
      seat: { row: 0, col: index },
    }));
    const collection = createCollection(
      {
        title: "追加発行",
        className: "テスト",
        pageCount: 2,
        requiredPages: [2],
        qrCorner: "top-right",
        duplex: false,
        order: "row",
        reverse: false,
      },
      students,
    );
    collection.printStudentOrder = ["1", "2", "0"];
    expect(
      printManifest(collection).map(
        ({ student, token }) => `${student.id}:${token.pageNumber}`,
      ),
    ).toEqual(["1:1", "1:2", "2:1", "2:2", "0:1", "0:2"]);
    collection.printStudentOrder = ["1", "1", "0"];
    expect(() => printManifest(collection)).toThrow("配布順");
  });
  it("uses the chosen start corner in the final student-page packets", () => {
    const students = [0, 1, 2, 3].map((index) => ({
      id: String(index),
      name: `生徒${index}`,
      number: index + 1,
      seat: { row: Math.floor(index / 2), col: index % 2 },
    }));
    const collection = createCollection(
      {
        title: "開始位置",
        className: "テスト",
        pageCount: 2,
        requiredPages: [2],
        qrCorner: "top-right",
        duplex: false,
        order: "row",
        reverse: false,
        startCorner: "bottom-right",
      },
      students,
    );
    expect(
      printManifest(collection).map(
        ({ student, token }) => `${student.id}:${token.pageNumber}`,
      ),
    ).toEqual(["3:1", "3:2", "2:1", "2:2", "1:1", "1:2", "0:1", "0:2"]);
  });
  it.each<QrCorner>(["top-right", "top-left", "bottom-right", "bottom-left"])(
    "preserves original scale and reserves readable-label space at %s",
    (corner) => {
      expect(
        sourceTransform(A4.width, A4.height, corner, "reserved-corner"),
      ).toEqual({ scale: 1, x: 0, y: 0 });
      const area = reservedArea(A4.width, A4.height, corner);
      const qr = qrBox(A4.width, A4.height, corner);
      expect(area.x).toBeLessThanOrEqual(qr.x);
      expect(area.x + area.width).toBeGreaterThanOrEqual(qr.x + qr.width);
      expect(area.y).toBe(qr.y);
    },
  );

  it("counts physical sheets and duplex spacer pages separately", () => {
    expect(printLayoutMetrics(3, 40, true)).toMatchObject({
      sheetsPerStudent: 2,
      totalSheets: 80,
      totalPages: 160,
      scale: 1,
    });
    expect(
      printLayoutMetrics(3, 40, false, "management-band").totalSheets,
    ).toBe(120);
    expect(
      printLayoutMetrics(3, 40, true, "management-band").scale,
    ).toBeLessThan(1);
  });
  it.each<QrCorner>(["top-right", "top-left", "bottom-right", "bottom-left"])(
    "keeps original content clear of QR at %s",
    (corner) => {
      const original = sourceTransform(A4.width, A4.height, corner);
      const qr = qrBox(A4.width, A4.height, corner);
      expect(qr.x).toBeGreaterThan(0);
      expect(qr.x + qr.width).toBeLessThan(A4.width);
      expect(qr.y).toBeGreaterThan(0);
      expect(qr.y + qr.height).toBeLessThan(A4.height);
      if (corner.startsWith("top"))
        expect(original.y + A4.height * original.scale).toBeLessThan(qr.y);
      else expect(original.y).toBeGreaterThan(qr.y + qr.height);
      expect(original.scale).toBeLessThan(1);
      expect(MANAGEMENT_BAND).toBeGreaterThan(qr.height);
    },
  );

  it.each([0, 90, 180, 270])(
    "normalizes a rotated source page (%s degrees) without clipping",
    (rotation) => {
      const placement = normalizedSourcePlacement(
        A4.width,
        A4.height,
        rotation,
        "top-right",
      );
      const radians = (placement.rotation * Math.PI) / 180;
      const corners = [
        [0, 0],
        [A4.width, 0],
        [0, A4.height],
        [A4.width, A4.height],
      ].map(([x, y]) => ({
        x:
          placement.x +
          placement.scale * (x * Math.cos(radians) - y * Math.sin(radians)),
        y:
          placement.y +
          placement.scale * (x * Math.sin(radians) + y * Math.cos(radians)),
      }));
      expect(Math.min(...corners.map((point) => point.x))).toBeGreaterThan(0);
      expect(Math.max(...corners.map((point) => point.x))).toBeLessThan(
        placement.pageWidth,
      );
      expect(Math.min(...corners.map((point) => point.y))).toBeGreaterThan(0);
      expect(Math.max(...corners.map((point) => point.y))).toBeLessThan(
        qrBox(placement.pageWidth, placement.pageHeight, "top-right").y,
      );
    },
  );
});
