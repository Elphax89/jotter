import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/**
 * Tiny service-worker generator: after bundling, it writes `sw.js` with the
 * exact list of built files so the app works fully offline after the first
 * visit. No extra dependency needed.
 */
function serviceWorker(): Plugin {
  return {
    name: "jotter-sw",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map"));
      const publicFiles = ["manifest.webmanifest", "favicon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
      const precache = ["./", ...[...files, ...publicFiles].map((f) => `./${f}`)];
      const version = Date.now().toString(36);
      const source = readFileSync(new URL("./src/sw.js", import.meta.url), "utf8")
        .replace("__VERSION__", version)
        .replace("__PRECACHE__", JSON.stringify(precache));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  // Relative base: works on GitHub Pages (/<repo>/), any sub-folder, or a custom domain.
  base: "./",
  build: {
    target: "es2022",
    cssMinify: true,
    modulePreload: { polyfill: false },
  },
  plugins: [serviceWorker()],
});
