/**
 * Central Auth.js (next-auth v5) configuration.
 * Exports: handlers (for the API route), auth (server-side session getter),
 *          signIn, signOut (for client/server actions).
 *
 * Brute-force helpers stay in src/lib/auth.ts so they can be imported by
 * session.ts (extension Basic auth) without a circular dependency.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { ensureDefaultOrg } from "@/lib/org";
import { checkLoginLocked, recordLoginFailure, clearLoginFailures } from "@/lib/auth";

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.NEXTAUTH_SECRET,
  trustHost: true, // required for Railway — allows auth cookies on the Railway domain

  providers: [
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const secret = process.env.NEXTAUTH_SECRET?.trim();
        if (!secret || secret.length < 32) {
          throw new Error("Server misconfiguration: NEXTAUTH_SECRET must be set and ≥32 chars.");
        }

        const username = (credentials?.username as string | undefined)?.trim();
        const password  = credentials?.password as string | undefined;
        if (!username || !password) return null;

        const key = username.toLowerCase();

        const { locked, minsLeft } = await checkLoginLocked(key);
        if (locked) {
          throw new Error(`Too many failed attempts — try again in ${minsLeft} minute${minsLeft !== 1 ? "s" : ""}.`);
        }

        let user = await prisma.user.findUnique({ where: { username } });

        if (!user) {
          await recordLoginFailure(key);
          return null;
        }

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
          await recordLoginFailure(key);
          return null;
        }

        await clearLoginFailures(key);

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
        const u = user as { id?: string; role?: string; orgId?: string | null };
        token.role  = u.role;
        token.sub   = u.id;   // v5 uses `sub` for the user id
        token.orgId = u.orgId ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id    = token.sub    ?? "";
      session.user.role  = (token.role  as string) ?? "";
      session.user.orgId = (token.orgId as string | null) ?? null;
      return session;
    },
  },

  pages: {
    signIn: "/login",
  },

  session: {
    strategy: "jwt",
    maxAge: 12 * 60 * 60, // 12 hours
  },
});
