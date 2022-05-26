# Notes on package.json
## (because json5 would allow comments but node is a bag of dicks)

`main` points to the dist directory, because that's where esbuild builds to.  electron uses main to find where to run things.
`build` is specifically all of the electron-build config variables
