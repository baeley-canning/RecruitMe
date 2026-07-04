import { TokenRedeemForm } from "@/components/auth/token-redeem-form";

// Public page behind an invite LINK (single-use token in the URL). The token
// is the credential; no session exists yet by definition.
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <TokenRedeemForm kind="invite" token={token} />;
}
