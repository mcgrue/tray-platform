const esbuild = require('esbuild')

// TODO: make these settable from args
const sourcemap = true
const watch = false
const minify = false

/// server translation
esbuild
  .build({
    entryPoints: ['src/main/index.ts'],
    // tsconfig: './tsconfig.json',
    bundle: true,
    sourcemap,
    minify,
    watch,
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
    return process.exit(1)
  })

/// client translation
esbuild
  .build({
    entryPoints: ['src/app/index.ts'],
    // tsconfig: './tsconfig.json',
    bundle: true,
    sourcemap,
    minify,
    watch,
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
    return process.exit(2)
  })
