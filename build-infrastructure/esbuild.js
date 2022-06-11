const esbuild = require('esbuild');

// TODO: make these settable from args
const sourcemap = true;
const watch = false;
const minify = false;

(async () => {
  /// server translation
  const result = await esbuild
    .build({
      entryPoints: ['src/main/index.ts'],
      // tsconfig: './tsconfig.json',
      bundle: true,
      sourcemap,
      minify,
      watch,
      metafile: true,
      platform: 'node',
      outfile: 'dist/main/index.js',
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
      entryPoints: ['src/app/index.ts'],
      // tsconfig: './tsconfig.json',
      bundle: true,
      sourcemap,
      minify,
      watch,
      metafile: true,
      platform: 'browser',
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
