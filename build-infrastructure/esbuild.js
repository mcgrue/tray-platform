const esbuild = require('esbuild');

// TODO: make these settable from args
const sourcemap = true;
const watch = false;
const minify = false;

(async () => {
  /// server translation
  const result = await esbuild
    .build({
      tsconfig: 'build-infrastructure/tsconfig.json',

      // logLevel: 'verbose',

      bundle: true,
      sourcemap,
      minify,
      watch,
      metafile: true,
      platform: 'node',
      entryPoints: ['src/main/index.ts'],
      outfile: 'dist/main/index.js',
      external: ['electron'],
      // plugins: [
      //   extensionResolverPlugin(['coffee', 'jadelet']),
      //   coffeeScriptPlugin({
      //     bare: true,
      //     inlineMap: sourcemap,
      //   }),
      // ],
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
      tsconfig: 'build-infrastructure/tsconfig.json',

      // logLevel: 'verbose',

      bundle: true,
      sourcemap,
      minify,
      watch,
      metafile: true,
      platform: 'browser',
      entryPoints: ['src/app/index.ts'],
      outfile: 'dist/app/index.js',
      // plugins: [
      //   extensionResolverPlugin(['coffee', 'jadelet']),
      //   coffeeScriptPlugin({
      //     bare: true,
      //     inlineMap: sourcemap,
      //   }),
      // ],
    })
    .catch(function () {
      return process.exit(2);
    });

  let text = await esbuild.analyzeMetafile(result.metafile);
  console.log(text);
})();
