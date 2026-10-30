import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

// pdfjs-dist requires a worker configured; in serverless environments, static assignment to globalThis prevents missing worker file errors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).pdfjsWorker = pdfjsWorker;

export const PAGE = "<<PAGE>>";

interface TextItemObj {
  str: string;
  x: number;
  y: number;
}

export async function pdfToLines(
  buf: ArrayBuffer | Uint8Array,
  password?: string
): Promise<string[]> {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // pdfjs types lack complete definitions for getDocument parameters in legacy bundle; any used here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadingTask: any = (pdfjs as any).getDocument({
    data,
    password,
    useSystemFonts: true,
    isEvalSupported: false,
    standardFontDataUrl: "https://unpkg.com/pdfjs-dist@4.10.38/standard_fonts/",
  });

  const doc = await loadingTask.promise;
  const lines: string[] = [];

  try {
    const numPages = doc.numPages;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      lines.push(PAGE);
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();

      const items: TextItemObj[] = [];
      for (const item of textContent.items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const textItem = item as any;
        if (typeof textItem.str === "string" && textItem.str.length > 0) {
          const x = Array.isArray(textItem.transform) ? Number(textItem.transform[4]) : 0;
          const y = Array.isArray(textItem.transform) ? Number(textItem.transform[5]) : 0;
          items.push({ str: textItem.str, x, y });
        }
      }

      // Group into rows by y with tolerance 3.5
      // Sort items descending by y first
      items.sort((a, b) => b.y - a.y);

      const rows: { y: number; items: TextItemObj[] }[] = [];
      for (const item of items) {
        let matchedRow = rows.find((r) => Math.abs(r.y - item.y) <= 3.5);
        if (!matchedRow) {
          matchedRow = { y: item.y, items: [] };
          rows.push(matchedRow);
        }
        matchedRow.items.push(item);
      }

      // Sort rows descending by y (top to bottom)
      rows.sort((a, b) => b.y - a.y);

      // Within each row, sort items ascending by x (left to right)
      for (const row of rows) {
        row.items.sort((a, b) => a.x - b.x);
        const rowText = row.items
          .map((it) => it.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (rowText.length > 0) {
          lines.push(rowText);
        }
      }
    }
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore cleanup errors
    }
  }

  return lines;
}
