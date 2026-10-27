import { defineConfig } from "vite";

// Local stand-in for Claude, served by the MCP server at /dev/.
export default defineConfig({
  root: "src/dev-host",
  base: "/dev/",
  build: { outDir: "../../dist/dev-host", emptyOutDir: true, target: "es2022" },
});
