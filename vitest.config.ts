import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals:     true,
    // Exclude vitest defaults + agent worktrees. The `Agent` tool with
    // isolation="worktree" leaves snapshots under .claude/worktrees/ that
    // vitest would otherwise pick up and run against the current tree —
    // which fails because the snapshots target stale code.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
      ".claude/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
