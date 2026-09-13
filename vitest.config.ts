import { defineConfig } from "vitest/config";

// Three projects, one per workspace package that ships tests. All run under
// plain Node for now ("pool node" per the plan) — apps/worker gets a real
// Workers runtime (miniflare / @cloudflare/vitest-pool-workers) in a later
// phase once there is Worker-specific behaviour (KV, OAuthProvider) to
// exercise; Phase 0's worker test is just a stub fetch handler, which runs
// fine under Node.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "cli",
          root: "./apps/cli",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "worker",
          root: "./apps/worker",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
  },
});
