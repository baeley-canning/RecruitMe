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

const TEAL = "1A8A82";
const FONT = "Times New Roman";
const PT = (pt: number) => pt * 2; // half-points

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
  workHistory: Array<{ company: string; role: string; dateRange: string }>;
  qualifications: Array<{ institution: string; courseYear: string }>;
}

function noBorder() {
  return { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
}

function tealHeading(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, color: TEAL, size: PT(13), font: FONT })],
    spacing: { before: PT(10), after: PT(6) },
  });
}

function bodyParagraph(text: string, opts: { bold?: boolean; italic?: boolean; spacing?: number } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italic, size: PT(12), font: FONT })],
    spacing: { after: opts.spacing ?? PT(4) },
  });
}

function emptyLine(): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: "", size: PT(12), font: FONT })], spacing: { after: 0 } });
}

function coverLabelCell(text: string): TableCell {
  return new TableCell({
    width: { size: 35, type: WidthType.PERCENTAGE },
    borders: { top: noBorder(), bottom: noBorder(), left: noBorder(), right: noBorder() },
    verticalAlign: VerticalAlign.TOP,
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text, bold: true, size: PT(12), font: FONT })],
        spacing: { after: PT(8) },
      }),
    ],
  });
}

function coverValueCell(paragraphs: Paragraph[]): TableCell {
  return new TableCell({
    width: { size: 65, type: WidthType.PERCENTAGE },
    borders: { top: noBorder(), bottom: noBorder(), left: noBorder(), right: noBorder() },
    verticalAlign: VerticalAlign.TOP,
    children: paragraphs,
  });
}

function valueText(text: string, opts: { color?: string } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, size: PT(12), font: FONT, color: opts.color })],
    spacing: { after: PT(4) },
  });
}

function coverRow(label: string, valueParagraphs: Paragraph[]): TableRow {
  return new TableRow({
    children: [coverLabelCell(label), coverValueCell(valueParagraphs)],
  });
}

function consultantCell(name: string, email: string, phone: string): Paragraph[] {
  return [
    valueText(name),
    new Paragraph({
      children: [new TextRun({ text: email, size: PT(12), font: FONT, color: "0563C1" })],
      spacing: { after: PT(4) },
    }),
    valueText(phone),
    emptyLine(),
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildCoverPage(data: ProfileDocData): any[] {
  const logoPath = path.join(process.cwd(), "public", "placeme-logo.png");
  const hasLogo = fs.existsSync(logoPath);

  const logoBlock = hasLogo
    ? new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: fs.readFileSync(logoPath),
            transformation: { width: 220, height: 110 },
            type: "png",
          }),
        ],
        spacing: { after: PT(24) },
      })
    : new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "PlaceMe", bold: true, size: PT(28), font: FONT, color: "808080" }),
          new TextRun({ text: " IT Recruitment", size: PT(18), font: FONT, color: "1A8A82" }),
        ],
        spacing: { after: PT(24) },
      });

  const title = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "Candidate Profile", bold: true, size: PT(18), font: FONT })],
    spacing: { before: PT(24), after: PT(36) },
  });

  const table = new Table({
    width: { size: 90, type: WidthType.PERCENTAGE },
    borders: { top: noBorder(), bottom: noBorder(), left: noBorder(), right: noBorder(), insideHorizontal: noBorder(), insideVertical: noBorder() },
    rows: [
      coverRow("Candidate:", [valueText(data.candidateName)]),
      coverRow("Role:", [valueText(data.role)]),
      coverRow("Date Referred:", [valueText(data.dateReferred)]),
      coverRow("Date Available:", [valueText(data.dateAvailable)]),
      coverRow("Your Consultant:", consultantCell(data.consultant.name, data.consultant.email, data.consultant.phone)),
      coverRow("Your Candidate Manager:", consultantCell(data.manager.name, data.manager.email, data.manager.phone)),
    ],
  });

  const spacer = new Paragraph({ children: [], spacing: { before: PT(60) } });

  const legal = new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [new TextRun({ text: LEGAL_TEXT, size: PT(8), font: FONT, color: "404040" })],
    spacing: { before: PT(60) },
  });

  return [logoBlock, title, table, spacer, legal];
}

function buildExecutiveSummaryPage(data: ProfileDocData): Paragraph[] {
  const paragraphs = data.executiveSummary
    .split(/\n\n+/)
    .filter(Boolean)
    .map((p) => bodyParagraph(p.trim(), { spacing: PT(10) }));

  return [tealHeading("Executive Summary"), emptyLine(), ...paragraphs];
}

function buildWorkHistoryPage(data: ProfileDocData): Paragraph[] {
  const children: Paragraph[] = [tealHeading("Work History"), emptyLine()];

  for (const job of data.workHistory) {
    children.push(bodyParagraph(`${job.company} | ${job.role}`, { bold: true, spacing: 0 }));
    children.push(bodyParagraph(job.dateRange, { spacing: PT(10) }));
  }

  children.push(emptyLine(), tealHeading("Qualifications"), emptyLine());

  if (data.qualifications.length === 0) {
    children.push(bodyParagraph("No formal qualifications listed."));
  } else {
    for (const qual of data.qualifications) {
      children.push(bodyParagraph(qual.institution, { spacing: 0 }));
      children.push(bodyParagraph(qual.courseYear, { italic: true, spacing: PT(10) }));
    }
  }

  return children;
}

function candidateNameHeader(name: string): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: name, size: PT(12), font: FONT })],
        spacing: { after: 0 },
      }),
    ],
  });
}

export async function generateProfileDocx(data: ProfileDocData): Promise<Buffer> {
  const header = candidateNameHeader(data.candidateName);

  const doc = new Document({
    sections: [
      {
        properties: { type: SectionType.NEXT_PAGE },
        children: buildCoverPage(data),
      },
      {
        properties: { type: SectionType.NEXT_PAGE },
        headers: { default: header },
        children: buildExecutiveSummaryPage(data),
      },
      {
        properties: {},
        headers: { default: candidateNameHeader(data.candidateName) },
        children: buildWorkHistoryPage(data),
      },
    ],
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}
