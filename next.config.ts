import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pdf-parse", "@prisma/client", "prisma"],
};

// Include Prisma query engine binaries in the standalone bundle.
// Cast needed because the type definition lags behind Next.js releases.
(nextConfig as Record<string, unknown>).outputFileTracingIncludes = {
  "/**": [
    "./node_modules/.prisma/client/*.node",
    "./node_modules/.prisma/client/libquery_engine*",
    "./node_modules/.prisma/client/query_engine*",
  ],
};

export default nextConfig;
