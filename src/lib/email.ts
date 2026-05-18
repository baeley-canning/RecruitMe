import { Resend } from "resend";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not configured");
    _resend = new Resend(key);
  }
  return _resend;
}

const FROM = process.env.RESEND_FROM ?? "RecruitMe <noreply@recruitme.app>";

export interface OutreachEmailOptions {
  to: string;
  candidateName: string;
  recruiterName: string;
  jobTitle: string;
  company: string;
  messageBody: string;
}

export async function sendOutreachEmail(opts: OutreachEmailOptions) {
  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from: FROM,
    to: opts.to,
    subject: `${opts.jobTitle} at ${opts.company} — Exciting Opportunity`,
    html: buildOutreachHtml(opts),
    text: opts.messageBody,
  });
  if (error) throw new Error(error.message);
  return data;
}

export interface RejectionEmailOptions {
  to: string;
  candidateName: string;
  jobTitle: string;
  company: string;
}

export async function sendRejectionEmail(opts: RejectionEmailOptions) {
  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from: FROM,
    to: opts.to,
    subject: `Your application for ${opts.jobTitle} at ${opts.company}`,
    html: buildRejectionHtml(opts),
    text: `Hi ${opts.candidateName},\n\nThank you for your interest in the ${opts.jobTitle} role at ${opts.company}. After careful consideration, we have decided to move forward with other candidates at this time.\n\nWe appreciate your time and wish you well in your search.`,
  });
  if (error) throw new Error(error.message);
  return data;
}

function buildOutreachHtml(opts: OutreachEmailOptions): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = esc(opts.messageBody).replace(/\n/g, "<br>");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b;font-size:15px;line-height:1.6">
<p>Hi ${esc(opts.candidateName)},</p>
<p>${body}</p>
<p style="margin-top:24px;font-size:13px;color:#64748b">—&nbsp;${esc(opts.recruiterName)}</p>
</body></html>`;
}

function buildRejectionHtml(opts: RejectionEmailOptions): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b;font-size:15px;line-height:1.6">
<p>Hi ${esc(opts.candidateName)},</p>
<p>Thank you for your interest in the <strong>${esc(opts.jobTitle)}</strong> role at <strong>${esc(opts.company)}</strong>.</p>
<p>After careful consideration, we have decided to move forward with other candidates at this time. We appreciate your time and wish you all the best in your search.</p>
</body></html>`;
}
