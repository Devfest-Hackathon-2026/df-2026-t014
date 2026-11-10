// Load PDF engines only when a document is opened or processed.
import type * as Pdf from "./pdf";
export async function generatePrintPdf(
  ...args: Parameters<typeof Pdf.generatePrintPdf>
) {
  return (await import("./pdf")).generatePrintPdf(...args);
}
export async function scanPdf(...args: Parameters<typeof Pdf.scanPdf>) {
  return (await import("./pdf")).scanPdf(...args);
}
export async function createDemoScan(
  ...args: Parameters<typeof Pdf.createDemoScan>
) {
  return (await import("./pdf")).createDemoScan(...args);
}
export async function extractStudentPdf(
  ...args: Parameters<typeof Pdf.extractStudentPdf>
) {
  return (await import("./pdf")).extractStudentPdf(...args);
}
export async function getPdfPageCount(
  ...args: Parameters<typeof Pdf.getPdfPageCount>
) {
  return (await import("./pdf")).getPdfPageCount(...args);
}
export async function inspectSourcePdf(
  ...args: Parameters<typeof Pdf.inspectSourcePdf>
) {
  return (await import("./pdf")).inspectSourcePdf(...args);
}
export async function generatePrintPreview(
  ...args: Parameters<typeof Pdf.generatePrintPreview>
) {
  return (await import("./pdf")).generatePrintPreview(...args);
}
export async function generateSourcePdf(
  ...args: Parameters<typeof Pdf.generateSourcePdf>
) {
  return (await import("./pdf")).generateSourcePdf(...args);
}
