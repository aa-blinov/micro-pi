#!/usr/bin/env node
/**
 * Bundles src/index.ts into a single dist/index.js — no tsx/esbuild needed
 * at runtime, unlike the dev-mode `npm start`/cast.sh path, which
 * transpiles from src/ on every invocation. Used by the release workflow
 * (see .github/workflows/release.yml) to produce what install.sh ships.
 *
 * npm dependencies (openai, @modelcontextprotocol/sdk) are bundled in too, so
 * the output needs nothing from node_modules at runtime — just Node.js
 * itself.
 *
 * import.meta.url inside bundled code resolves to dist/index.js's own
 * location for every module that got inlined into it (verified: esbuild
 * doesn't preserve per-source-file import.meta.url after bundling). Every
 * ../prompts and ../package.json read in src/ assumes "one directory below
 * the repo root" — true for src/, and still true for dist/ as long as it
 * stays a sibling of prompts/ and package.json, which is how the release
 * archive is laid out (see .github/workflows/release.yml).
 */
import { build } from "esbuild";

	await build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node18", // matches the oldest Node version CI actually tests (see .github/workflows/ci.yml)
		outfile: "dist/index.js",
		// ink optionally imports react-devtools-core for its DevTools integration,
		// gated behind `if (process.env.DEV === 'true')` — but that file (devtools.js)
		// is a *local* ink module, so esbuild inlines it into this single outfile
		// instead of leaving it as a separate dynamic-import chunk. Its own static
		// `import devtools from 'react-devtools-core'` then has nowhere to go but
		// the top of the bundle — and a static ESM import is resolved by Node before
		// any code runs, DEV-guard or not. Marking the package `external` used to
		// "fix" the bundle-time error, but just moved the crash to runtime: Node
		// then eagerly resolves that top-level import against the *install*
		// directory's node_modules, where the (genuinely optional, dev-only)
		// package was never installed — ERR_MODULE_NOT_FOUND on every launch.
		// Stubbing it out with an empty module keeps the bundle fully
		// self-contained; the DEV=true devtools-connect path (never exercised in
		// a release install) just gets a no-op default export instead.
		plugins: [
			{
				name: "stub-react-devtools-core",
				setup(pluginBuild) {
					pluginBuild.onResolve({ filter: /^react-devtools-core$/ }, () => ({
						path: "react-devtools-core",
						namespace: "stub-react-devtools-core",
					}));
					pluginBuild.onLoad({ filter: /.*/, namespace: "stub-react-devtools-core" }, () => ({
						contents: "export default {};",
						loader: "js",
					}));
				},
			},
		],
	// @modelcontextprotocol/sdk drags in zod (both v3 and v4 code paths) and
	// ajv unconditionally; minifying cuts the unminified ~1.4mb bundle back
	// down to ~800kb without touching what actually ships behaviorally.
	minify: true,
	// A CJS dependency pulled in transitively by openai (node-fetch, used by
	// its bundled fetch polyfill path) calls require() with an argument
	// esbuild can't statically resolve at bundle time, and ESM output has no
	// require at all — confirmed by testing: running the bundle without this
	// throws "Dynamic require of 'stream' is not supported". createRequire
	// gives that call a real, working require backed by Node's own resolver.
	banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
	logLevel: "info",
});
