// Load the PDF engine only when a document is opened.
import type * as Pdf from "./pdf";

export async function scanPdf(...args: Parameters<typeof Pdf.scanPdf>) {
  return (await import("./pdf")).scanPdf(...args);
}
