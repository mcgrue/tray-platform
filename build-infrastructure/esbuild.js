const esbuild = require("esbuild");
const pluginCopy = require("esbuild-plugin-copy");

// TODO: make these settable from args
const sourcemap = true;
const watch = false;
const minify = false;

(async () => {
  /// server translation
  const result = await esbuild
    .build({
      tsconfig: "build-infrastructure/tsconfig.json",

      // logLevel: 'verbose',

      bundle: true,
      sourcemap,
      minify,
      watch,
      metafile: true,
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
      tsconfig: "build-infrastructure/tsconfig.json",

      // logLevel: 'verbose',

      bundle: true,
      sourcemap,
      minify,
      watch,
      metafile: true,
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
      ],
    })
    .catch(function () {
      return process.exit(2);
    });

  let text = await esbuild.analyzeMetafile(result.metafile);
  console.log(text);
})();
