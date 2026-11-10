import { orderStudents } from "../domain/logic";
import type { Collection, PageToken, QrCorner, Student } from "../domain/types";

export const A4 = { width: 595.28, height: 841.89 };
export const mm = (value: number) => (value * 72) / 25.4;
export const QR_SIZE = mm(25);
export const PAGE_MARGIN = mm(10);
export const MANAGEMENT_BAND = mm(38);
export type LayoutMode = "reserved-corner" | "management-band";
export const RESERVED_WIDTH = mm(90);

/** The teacher reserves this entire block for both QR and readable labels. */
export function reservedArea(width: number, height: number, corner: QrCorner) {
  const box = qrBox(width, height, corner);
  return {
    x: corner.endsWith("right")
      ? width - PAGE_MARGIN - RESERVED_WIDTH
      : PAGE_MARGIN,
    y: box.y,
    width: RESERVED_WIDTH,
    height: QR_SIZE,
  };
}

export function qrBox(width: number, height: number, corner: QrCorner) {
  const right = corner.endsWith("right");
  const top = corner.startsWith("top");
  return {
    x: right ? width - PAGE_MARGIN - QR_SIZE : PAGE_MARGIN,
    y: top ? height - PAGE_MARGIN - QR_SIZE : PAGE_MARGIN,
    width: QR_SIZE,
    height: QR_SIZE,
  };
}

export function sourceTransform(
  width: number,
  height: number,
  corner: QrCorner,
  layoutMode: LayoutMode = "management-band",
) {
  if (
    width < mm(100) ||
    height < mm(140) ||
    width > mm(1000) ||
    height > mm(1000)
  ) {
    throw new Error(
      "この原稿の用紙サイズには対応していません。A4サイズのPDFを選択してください。",
    );
  }
  if (layoutMode === "reserved-corner") return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(
    (width - PAGE_MARGIN * 2) / width,
    (height - MANAGEMENT_BAND - PAGE_MARGIN) / height,
  );
  return {
    scale,
    x: (width - width * scale) / 2,
    y: corner.startsWith("top") ? PAGE_MARGIN : MANAGEMENT_BAND,
  };
}

export function normalizedSourcePlacement(
  width: number,
  height: number,
  rotation: number,
  corner: QrCorner,
  layoutMode: LayoutMode = "management-band",
) {
  const angle = ((rotation % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(angle))
    throw new Error("原稿の回転角度を確認してください。");
  const pageWidth = angle === 90 || angle === 270 ? height : width;
  const pageHeight = angle === 90 || angle === 270 ? width : height;
  const position = sourceTransform(pageWidth, pageHeight, corner, layoutMode);
  const offsets = {
    0: { x: 0, y: 0 },
    90: { x: 0, y: width * position.scale },
    180: { x: width * position.scale, y: height * position.scale },
    270: { x: height * position.scale, y: 0 },
  }[angle as 0 | 90 | 180 | 270];
  return {
    pageWidth,
    pageHeight,
    scale: position.scale,
    x: position.x + offsets.x,
    y: position.y + offsets.y,
    rotation: -angle,
  };
}

export function printLayoutMetrics(
  pageCount: number,
  studentCount: number,
  duplex: boolean,
  layoutMode: LayoutMode = "reserved-corner",
) {
  const pagesPerStudent = duplex ? Math.ceil(pageCount / 2) * 2 : pageCount;
  return {
    logicalPagesPerStudent: pageCount,
    pagesPerStudent,
    sheetsPerStudent: duplex ? pagesPerStudent / 2 : pagesPerStudent,
    totalPages: pagesPerStudent * studentCount,
    totalSheets:
      (duplex ? pagesPerStudent / 2 : pagesPerStudent) * studentCount,
    scale: sourceTransform(A4.width, A4.height, "top-right", layoutMode).scale,
    reservedWidthMm: 90,
    reservedHeightMm: 25,
  };
}

export interface PrintManifestPage {
  student: Student;
  token: PageToken;
}

export function printManifest(
  collection: Collection,
  fallbackStudents: Student[] = [],
): PrintManifestPage[] {
  let students = orderStudents(
    collection.recipients.length ? collection.recipients : fallbackStudents,
    collection.order,
    collection.reverse,
    collection.startCorner,
  );
  if (collection.printStudentOrder) {
    const ids = collection.printStudentOrder;
    const byId = new Map(students.map((student) => [student.id, student]));
    if (
      ids.length !== students.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !byId.has(id))
    )
      throw new Error(
        "発行時の配布順と対象名簿が一致しません。台帳を確認してください。",
      );
    students = ids.map((id) => byId.get(id)!);
  }
  const tokens = new Map(
    collection.tokens.map((token) => [
      `${token.studentId}:${token.kind}:${token.pageNumber}`,
      token,
    ]),
  );
  const pages: PrintManifestPage[] = [];
  for (const student of students) {
    for (let number = 1; number <= collection.pageCount; number++) {
      const token = tokens.get(`${student.id}:content:${number}`);
      if (!token)
        throw new Error(
          "ページとQRの対応表が不足しています。配布物を作り直してください。",
        );
      pages.push({ student, token });
    }
    if (collection.duplex && collection.pageCount % 2 === 1) {
      const spacer = tokens.get(
        `${student.id}:spacer:${collection.pageCount + 1}`,
      );
      if (!spacer)
        throw new Error("両面印刷の調整ページに対応するQRがありません。");
      pages.push({ student, token: spacer });
    }
  }
  return pages;
}
