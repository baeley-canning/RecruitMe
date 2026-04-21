import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuth, unauthorized } from "@/lib/session";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
];
const ALLOWED_EXTS = /\.(pdf|doc|docx|txt|md)$/i;

async function requireAccess(candidateId: string, auth: NonNullable<Awaited<ReturnType<typeof getAuth>>>) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: { job: { select: { orgId: true } } },
  });
  if (!candidate) return null;
  if (!auth.isOwner && candidate.job.orgId !== auth.orgId) return null;
  return candidate;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const candidate = await requireAccess(id, auth);
  if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const files = await prisma.candidateFile.findMany({
    where: { candidateId: id },
    select: { id: true, type: true, filename: true, mimeType: true, size: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(files);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuth();
  if (!auth) return unauthorized();
  const { id } = await params;

  const candidate = await requireAccess(id, auth);
  if (!candidate) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  const type = (formData.get("type") as string | null) ?? "other";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!["cv", "cover_letter", "other"].includes(type)) {
    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 413 });
  }
  if (!ALLOWED_EXTS.test(file.name) && !ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "File type not allowed. Use PDF, Word, or plain text." }, { status: 415 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const base64 = buffer.toString("base64");

  const created = await prisma.candidateFile.create({
    data: {
      candidateId: id,
      type,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      data: base64,
      size: file.size,
    },
    select: { id: true, type: true, filename: true, mimeType: true, size: true, createdAt: true },
  });

  return NextResponse.json(created, { status: 201 });
}
