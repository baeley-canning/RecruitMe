import type { Buffer } from "buffer";

// pdf-parse bundles multiple pdfjs versions. Newer versions recover from
// common PDF formatting issues (bad XRef entries, linearisation problems).
// Try each in order until one succeeds.
const PDF_VERSIONS = ["v2.0.550", "v1.10.100", "v1.10.88", "v1.9.426"] as const;

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");

  let lastError: unknown;

  for (const version of PDF_VERSIONS) {
    try {
      const data = await pdfParse(buffer, { version });
      const text = (data.text as string) ?? "";
      if (text.trim().length > 0) return text;
    } catch (err) {
      lastError = err;
      // Try the next version
    }
  }

  throw lastError ?? new Error("All PDF parsing attempts failed");
}
