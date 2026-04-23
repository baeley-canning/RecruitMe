import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "./db";
import bcrypt from "bcryptjs";
import { ensureDefaultOrg } from "./org";

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;

        let user = await prisma.user.findUnique({
          where: { username: credentials.username },
        });

        if (!user) return null;

        const valid = await bcrypt.compare(credentials.password, user.password);
        if (!valid) return null;

        if (user.role !== "owner" && !user.orgId) {
          const defaultOrg = await ensureDefaultOrg();
          user = await prisma.user.update({
            where: { id: user.id },
            data: { orgId: defaultOrg.id },
          });
        }

        return {
          id: user.id,
          name: user.username,
          role: user.role,
          orgId: user.orgId ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const authUser = user as { id?: string; role?: string; orgId?: string | null };
        token.role = authUser.role;
        token.id = authUser.id;
        token.orgId = authUser.orgId ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const u = session.user as Record<string, unknown>;
        u.role  = token.role;
        u.id    = token.id;
        u.orgId = token.orgId ?? null;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
};
