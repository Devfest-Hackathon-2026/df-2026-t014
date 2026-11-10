import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontUrl from "./assets/BIZUDGothic-Regular.ttf?url";

let fontBytes: Promise<Uint8Array> | undefined;
const embeddedFonts = new WeakMap<PDFDocument, Promise<PDFFont>>();
const characterSets = new WeakMap<PDFFont, Set<number>>();

async function loadFontBytes() {
  fontBytes ??= fetch(fontUrl)
    .then(async (response) => {
      if (!response.ok)
        throw new Error(
          "日本語フォントを読み込めませんでした。再試行してください。",
        );
      return new Uint8Array(await response.arrayBuffer());
    })
    .catch((error) => {
      fontBytes = undefined;
      throw error;
    });
  return fontBytes;
}

export async function embedJapaneseFont(doc: PDFDocument): Promise<PDFFont> {
  let embedded = embeddedFonts.get(doc);
  if (!embedded) {
    doc.registerFontkit(fontkit);
    embedded = loadFontBytes().then((bytes) =>
      // pdf-lib 1.17.1/fontkit subsetting drops BIZUDGothic glyph outlines:
      // extracted text is intact, but PDF.js renders most Japanese characters blank.
      // Embed the complete font once per document until that path is fixed.
      // https://github.com/Hopding/pdf-lib/issues/1232
      doc.embedFont(bytes, { subset: false }),
    );
    embeddedFonts.set(doc, embedded);
  }
  return embedded;
}

export interface TextStyle {
  x: number;
  y: number;
  size?: number;
  width?: number;
  color?: string;
  weight?: number;
}

/** Add searchable Japanese PDF text, using the same bundled font on every device. */
export async function drawJapanese(
  doc: PDFDocument,
  page: PDFPage,
  text: string,
  style: TextStyle,
) {
  const font = await embedJapaneseFont(doc);
  let characterSet = characterSets.get(font);
  if (!characterSet) {
    characterSet = new Set(font.getCharacterSet());
    characterSets.set(font, characterSet);
  }
  const missing = [...text].filter(
    (character) => !characterSet.has(character.codePointAt(0)!),
  );
  if (missing.length)
    throw new Error(
      `同梱フォントにない文字があります: ${[...new Set(missing)].join("")}。氏名・配布物名を確認してください。`,
    );
  const naturalSize = style.size ?? 12;
  const textWidth = font.widthOfTextAtSize(text, naturalSize);
  const size =
    style.width && textWidth > style.width
      ? (naturalSize * style.width) / textWidth
      : naturalSize;
  const hex = (style.color ?? "#18332f").replace("#", "");
  page.drawText(text, {
    x: style.x,
    y: style.y - size,
    size,
    font,
    color: rgb(
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    ),
  });
}
