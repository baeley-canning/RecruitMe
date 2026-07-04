import { TokenRedeemForm } from "@/components/auth/token-redeem-form";

// Public page behind a password-reset LINK (single-use token in the URL).
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <TokenRedeemForm kind="reset" token={token} />;
}
