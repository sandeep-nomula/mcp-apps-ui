import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The MCP App must be a single self-contained HTML file served as a ui:// resource.
export default defineConfig({
  root: "src/ui",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: "src/ui/quote-board.html" },
  },
});
