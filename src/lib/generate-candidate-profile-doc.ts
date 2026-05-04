import {
  AlignmentType,
  BorderStyle,
  Document,
  Header,
  ImageRun,
  Packer,
  Paragraph,
  SectionType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import fs from "fs";
import path from "path";

// Exact values from the .dotx template
const TEAL = "006976";
const FONT = "Calibri";
const LEGAL_FONT = "Arial";
const PT = (pt: number) => pt * 2; // OOXML sz is in half-points

// A4 dimensions and margins copied directly from template sectPr (twips)
const PAGE = {
  size: { width: 11901, height: 16840 },
  margin: { top: 720, right: 720, bottom: 302, left: 720, header: 734, footer: 1210 },
};

const LEGAL_TEXT =
  "Interview of candidates referred by placeMe Recruitment Ltd. shall be deemed acceptance of our standard terms of business or agreed terms of business and agreement to pay the relevant agency fee for such candidates employed by the organisation to whom the referral was made or any other organisation or person associated with it.";

export interface ProfileDocData {
  candidateName: string;
  role: string;
  dateReferred: string;
  dateAvailable: string;
  consultant: { name: string; email: string; phone: string };
  manager: { name: string; email: string; phone: string };
  executiveSummary: string;
  workHistory: Array<{ company: string; role: string; dateRange: string; bullets?: string[] }>;
  qualifications: Array<{ institution: string; courseYear: string }>;
}

function noBorder() {
  return { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
}

// Section heading: Calibri Bold 14pt #006976 (sz=28 in template)
function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, color: TEAL, size: PT(14), font: FONT })],
    spacing: { before: PT(10), after: PT(6) },
  });
}

// Body paragraph: Calibri 12pt (sz=24 = Normal in template)
function bodyParagraph(
  text: string,
  opts: { bold?: boolean; italic?: boolean; spacing?: number } = {},
): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italic, size: PT(12), font: FONT })],
    spacing: { after: opts.spacing ?? PT(4) },
  });
}

function emptyLine(): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: "", size: PT(12), font: FONT })],
    spacing: { after: 0 },
  });
}

function coverLabelCell(text: string): TableCell {
  return new TableCell({
    width: { size: 38, type: WidthType.PERCENTAGE },
    borders: {
      top: noBorder(), bottom: noBorder(), left: noBorder(), right: noBorder(),
    },
    verticalAlign: VerticalAlign.TOP,
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text, size: PT(12), font: FONT })],
        spacing: { after: PT(4) },
      }),
    ],
  });
}

function coverValueCell(paragraphs: Paragraph[]): TableCell {
  return new TableCell({
    width: { size: 62, type: WidthType.PERCENTAGE },
    borders: {
      top: noBorder(), bottom: noBorder(), left: noBorder(), right: noBorder(),
    },
    verticalAlign: VerticalAlign.TOP,
    children: paragraphs,
  });
}

function valueText(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, size: PT(12), font: FONT })],
    spacing: { after: PT(2) },
  });
}

function emptyRow(): TableRow {
  return new TableRow({
    children: [coverLabelCell(""), coverValueCell([emptyLine()])],
  });
}

function coverRow(label: string, valueParagraphs: Paragraph[]): TableRow {
  return new TableRow({
    children: [coverLabelCell(label), coverValueCell(valueParagraphs)],
  });
}

// Consultant/manager block: Name, email (blue hyperlink style), phone
function consultantBlock(name: string, email: string, phone: string): Paragraph[] {
  const rows: Paragraph[] = [valueText(name)];
  if (email) rows.push(new Paragraph({
    children: [new TextRun({ text: email, size: PT(12), font: FONT, color: "0563C1" })],
    spacing: { after: PT(2) },
  }));
  if (phone) rows.push(valueText(phone));
  return rows;
}

function buildCoverPage(data: ProfileDocData): (Paragraph | Table)[] {
  // Prefer jpg (extracted from template), fall back to png if user supplied one
  const logoJpg = path.join(process.cwd(), "public", "placeme-logo.jpg");
  const logoPng = path.join(process.cwd(), "public", "placeme-logo.png");
  const logoPath = fs.existsSync(logoJpg) ? logoJpg : fs.existsSync(logoPng) ? logoPng : null;
  const logoType = logoPath?.endsWith(".jpg") ? "jpg" : "png";

  // Logo dimensions from template: 6528151 × 2163723 EMU → ~685 × 227px at 96dpi
  const logoBlock = logoPath
    ? new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: fs.readFileSync(logoPath),
            transformation: { width: 685, height: 227 },
            type: logoType,
          }),
        ],
        spacing: { after: 0 },
      })
    : new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "place", bold: true, size: PT(28), font: FONT, color: "808080" }),
          new TextRun({ text: "me.", bold: true, size: PT(28), font: FONT, color: TEAL }),
          new TextRun({ text: "  IT RECRUITMENT", size: PT(11), font: FONT, color: "808080" }),
        ],
        spacing: { after: PT(12) },
      });

  // "Candidate Profile" title: Calibri Bold 16pt (sz=32 in template), centered
  const title = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Candidate Profile", bold: true, size: PT(16), font: FONT })],
    spacing: { before: PT(6), after: PT(20) },
  });

  const spacer = new Paragraph({ children: [], spacing: { before: 0, after: PT(6) } });

  // Details table (matches template's right-tab layout for label/value pairs)
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: noBorder(), bottom: noBorder(), left: noBorder(),
      right: noBorder(), insideHorizontal: noBorder(), insideVertical: noBorder(),
    },
    rows: [
      coverRow("Candidate:", [valueText(data.candidateName)]),
      emptyRow(),
      coverRow("Role:", [valueText(data.role)]),
      emptyRow(),
      coverRow("Date Referred:", [valueText(data.dateReferred)]),
      emptyRow(),
      coverRow("Date Available:", [valueText(data.dateAvailable)]),
      emptyRow(),
      coverRow("Your Consultant:", consultantBlock(data.consultant.name, data.consultant.email, data.consultant.phone)),
      emptyRow(),
      coverRow("Your Candidate Manager:", consultantBlock(data.manager.name, data.manager.email, data.manager.phone)),
    ],
  });

  // Legal text: Arial 8pt (sz=16 in template), justified
  const legalSpacer = new Paragraph({ children: [], spacing: { before: PT(48), after: 0 } });
  const legal = new Paragraph({
    alignment: AlignmentType.BOTH,
    children: [new TextRun({ text: LEGAL_TEXT, size: PT(8), font: LEGAL_FONT })],
    spacing: { before: 0, after: 0 },
  });

  return [logoBlock, title, spacer, table, legalSpacer, legal];
}

function buildExecutiveSummaryPage(data: ProfileDocData): Paragraph[] {
  const paragraphs = data.executiveSummary
    .split(/\n\n+/)
    .filter(Boolean)
    .map((p) => bodyParagraph(p.trim(), { spacing: PT(10) }));

  return [sectionHeading("Executive Summary"), emptyLine(), ...paragraphs];
}

function bulletPoint(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text, size: PT(12), font: FONT })],
    spacing: { after: PT(3) },
  });
}

function buildWorkHistoryPage(data: ProfileDocData): Paragraph[] {
  const children: Paragraph[] = [sectionHeading("Work History"), emptyLine()];

  for (const job of data.workHistory) {
    // Company name — Bold (own line, matches Sean's profile)
    children.push(bodyParagraph(job.company, { bold: true, spacing: 0 }));
    // "Role, Date Range" — Bold italic (matches Sean's profile format)
    const roleLine = job.dateRange && !job.role.includes(job.dateRange)
      ? `${job.role}`
      : job.role;
    children.push(bodyParagraph(roleLine, { italic: true, spacing: PT(4) }));
    // Bullet points of responsibilities/achievements
    const bullets = job.bullets ?? [];
    for (const bullet of bullets) {
      children.push(bulletPoint(bullet));
    }
    children.push(emptyLine());
  }

  children.push(emptyLine(), sectionHeading("Qualifications"), emptyLine());

  if (data.qualifications.length === 0) {
    children.push(bodyParagraph("No formal qualifications listed."));
  } else {
    for (const qual of data.qualifications) {
      // Institution — Bold (matches template)
      children.push(bodyParagraph(qual.institution, { bold: true, spacing: 0 }));
      // "Course | Year" — Italic (matches template)
      children.push(bodyParagraph(qual.courseYear, { italic: true, spacing: PT(10) }));
    }
  }

  return children;
}

// Header used on pages 2+: candidate name, Calibri Bold 16pt, right-aligned
function candidateHeader(name: string): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: name, bold: true, size: PT(16), font: FONT })],
        spacing: { after: 0 },
      }),
    ],
  });
}

export async function generateProfileDocx(data: ProfileDocData): Promise<Buffer> {
  const header = candidateHeader(data.candidateName);

  const doc = new Document({
    sections: [
      {
        // Cover page — no header (separate section = no inherited header)
        properties: { page: PAGE, type: SectionType.NEXT_PAGE },
        children: buildCoverPage(data),
      },
      {
        properties: { page: PAGE, type: SectionType.NEXT_PAGE },
        headers: { default: header },
        children: buildExecutiveSummaryPage(data),
      },
      {
        properties: { page: PAGE },
        headers: { default: header },
        children: buildWorkHistoryPage(data),
      },
    ],
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}
