const esbuild = require("esbuild");
const pluginCopy = require("esbuild-plugin-copy");
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

// Parse command line arguments
const watch = process.argv.includes("--watch");
const sourcemap = true;
const minify = false;

const commonConfig = {
  tsconfig: "build-infrastructure/tsconfig.json",
  bundle: true,
  sourcemap,
  minify,
  watch: watch
    ? {
        onRebuild(error, result) {
          if (error) console.error("watch build failed:", error);
          else console.log("watch build succeeded");
        },
      }
    : false,
  metafile: true,
};

// Keep the browser bundle independent of Electron's renderer and preload.
esbuild.build({
  ...commonConfig, platform: "browser", entryPoints: ["src/web/renderer.ts"], outfile: "dist/web/index.js", sourcemap: false,
  plugins: [{ name: "web-shell", setup(build) {
    build.onEnd(result => {
      if (result.errors.length) return;
      fs.mkdirSync("dist/web", { recursive: true });
      for (const name of ["index.html", "offline.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"]) {
        fs.copyFileSync(path.join("src/web", name), path.join("dist/web", name));
      }
      const hash = createHash("sha256");
      for (const name of ["index.js", "index.css", "offline.html", "icon-192.png", "icon-512.png"]) hash.update(fs.readFileSync(path.join("dist/web", name)));
      const worker = fs.readFileSync("src/web/sw.js", "utf8"); hash.update(worker);
      fs.writeFileSync("dist/web/sw.js", worker.replace(/CACHE_VERSION/g, hash.digest("hex").slice(0, 16)));
    });
  } }],
}).catch(() => process.exit(3));

(async () => {
  /// server translation
  const result = await esbuild
    .build({
      ...commonConfig,
      platform: "node",
      entryPoints: ["src/main/main.ts"],
      outfile: "dist/main/index.js",
      external: ["electron"],
      plugins: [
        pluginCopy.copy({
          // this is equal to process.cwd(), which means we use cwd path as base path to resolve `to` path
          // if not specified, this plugin uses ESBuild.build outdir/outfile options as base path.
          resolveFrom: "cwd",
          assets: {
            from: ["./src/main/resources/*"],
            to: ["./dist/main/resources"],
          },
          watch: true,
        }),
        pluginCopy.copy({
          // this is equal to process.cwd(), which means we use cwd path as base path to resolve `to` path
          // if not specified, this plugin uses ESBuild.build outdir/outfile options as base path.
          resolveFrom: "cwd",
          assets: {
            from: ["./src/main/preload_js.js"],
            to: ["./dist/main/preload_js.js"],
          },
          watch: true,
        }),
        pluginCopy.copy({
          resolveFrom: "cwd",
          assets: {
            from: ["./src/shared/*"],
            to: ["./dist/shared"],
          },
          watch: true,
        }),
      ],
    })
    .catch(function () {
      return process.exit(1);
    });

  let text = await esbuild.analyzeMetafile(result.metafile);
  console.log(text);
})();

(async () => {
  /// client translation
  const result = await esbuild
    .build({
      ...commonConfig,
      platform: "browser",
      entryPoints: ["src/app/renderer.ts"],
      outfile: "dist/app/index.js",
      plugins: [
        pluginCopy.copy({
          // this is equal to process.cwd(), which means we use cwd path as base path to resolve `to` path
          // if not specified, this plugin uses ESBuild.build outdir/outfile options as base path.
          resolveFrom: "cwd",
          assets: {
            from: ["./src/app/resources/*"],
            to: ["./dist/app/resources"],
          },
          watch: true,
        }),
        pluginCopy.copy({
          // this is equal to process.cwd(), which means we use cwd path as base path to resolve `to` path
          // if not specified, this plugin uses ESBuild.build outdir/outfile options as base path.
          resolveFrom: "cwd",
          assets: {
            from: ["./src/app/index.html"],
            to: ["./dist/app/index.html"],
          },
          watch: true,
        }),
        pluginCopy.copy({
          resolveFrom: "cwd",
          assets: {
            from: ["./src/shared/*"],
            to: ["./dist/shared"],
          },
          watch: true,
        }),
      ],
    })
    .catch(function () {
      return process.exit(2);
    });

  let text = await esbuild.analyzeMetafile(result.metafile);
  console.log(text);
})();
