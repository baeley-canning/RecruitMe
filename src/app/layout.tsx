import type { Metadata } from "next";
import "./globals.css";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AuthSessionProvider } from "@/components/session-provider";
import { Toaster } from "@/components/ui/toast";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";
import { WhiteLabelStyles } from "@/components/white-label-styles";

// SF Pro / system fonts only — no Google Fonts loader. The Logic Pro look
// depends on the OS-native typeface; Inter was the wrong call for this
// aesthetic. font-sans in Tailwind maps to the SF Pro stack via tailwind.config.

export const metadata: Metadata = {
  title: "RecruitMe",
  description: "AI-powered talent sourcing for recruiters",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  return (
    <html lang="en" className="dark">
      <head>
        <WhiteLabelStyles />
      </head>
      <body className="font-sans">
        <AuthSessionProvider session={session}>{children}</AuthSessionProvider>
        <Toaster />
        <ConfirmDialogHost />
      </body>
    </html>
  );
}
