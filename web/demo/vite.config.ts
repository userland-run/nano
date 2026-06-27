// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

import { defineConfig } from "vite";
import macros from "unplugin-parcel-macros";
import react from "@vitejs/plugin-react";
import path from "path";

const containerDir = path.resolve(__dirname, "../../container");
// The catalog client (Catalog/installer) lives in the SDK; the demo installs
// node + the toolchain from the catalog at boot now that nano.wasm is slim.
const sdkDist = path.resolve(__dirname, "../../../sdk/dist/index.js");

export default defineConfig({
  base: "/nano/",
  plugins: [macros.vite(), react()],
  resolve: {
    alias: {
      "@container": containerDir,
      "@sdk": sdkDist,
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
