import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: { entry: "src/card.ts", formats: ["es"], fileName: () => "zha-network-graph-card.js" },
    outDir: "dist",
  },
  test: {
    // The layout tests run real force and annealing searches, which take seconds on a loaded machine.
    testTimeout: 120_000,
  },
});
