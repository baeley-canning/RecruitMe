import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AuthSessionProvider } from "@/components/session-provider";
import { Toaster } from "@/components/ui/toast";

const inter = Inter({ subsets: ["latin"] });

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
    <html lang="en">
      <body className={inter.className}>
        <AuthSessionProvider session={session}>{children}</AuthSessionProvider>
        <Toaster />
      </body>
    </html>
  );
}
