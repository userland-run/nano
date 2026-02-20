import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const containerDir = path.resolve(__dirname, "../../container");

export default defineConfig({
  base: "/nano/",
  plugins: [react()],
  resolve: {
    alias: {
      "@container": containerDir,
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: ["codemirror", "@codemirror/lang-javascript", "@codemirror/theme-one-dark"],
        },
      },
    },
  },
  publicDir: "public",
});
