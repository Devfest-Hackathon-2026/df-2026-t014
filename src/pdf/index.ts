export {
  generatePrintPdf,
  generatePrintPreview,
  generateSourcePdf,
} from "./generate";
export { scanPdf } from "./scan";
export { createDemoScan } from "./demo";
export {
  extractStudentPdf,
  getPdfPageCount,
  inspectSourcePdf,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PAGES,
  MAX_PRINT_PAGES,
  MAX_PDF_BYTES,
  MAX_SCAN_PAGES,
} from "./documents";
export { renderPdfPage } from "./renderer";
export { printLayoutMetrics, reservedArea } from "./geometry";
export type { LayoutMode } from "./geometry";
export type { SourcePdfInfo } from "./documents";
