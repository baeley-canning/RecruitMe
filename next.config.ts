import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse", "@prisma/client", "prisma"],
};

export default nextConfig;
