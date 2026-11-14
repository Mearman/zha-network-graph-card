import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: { entry: "src/card.ts", formats: ["es"], fileName: () => "zha-network-graph-card.js" },
    outDir: "dist",
  },
});
