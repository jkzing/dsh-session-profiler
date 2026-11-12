#!/usr/bin/env node
/**
 * Build both halves into lib/.
 *
 *   lib/index.js   host half, ESM, runs in the dsh Node process
 *   lib/client.js  browser half, a classic script the dsh shell loads into its
 *                  module table through `window.__ModuleLoader__.load`
 *
 *   node scripts/build.mjs [--watch]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const watch = process.argv.includes('--watch')
const banner = `/*! ${pkg.name} v${pkg.version} | ${pkg.license} */`

/** Modules the shell seeds into the browser module table; everything else must be inlined. */
const PLATFORM_MODULES = ['react']

/** @type {import('esbuild').BuildOptions} */
const host = {
  entryPoints: { index: join(root, 'src/host/index.ts') },
  outdir: join(root, 'lib'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  charset: 'utf8',
  banner: { js: banner },
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const client = {
  entryPoints: { client: join(root, 'src/client/index.ts') },
  outdir: join(root, 'lib'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  minify: !watch,
  external: PLATFORM_MODULES,
  loader: { '.css': 'text' },
  charset: 'utf8',
  // The bundle is a classic script with its own `module` object, not a Node module.
  logOverride: { 'commonjs-variable-in-esm': 'silent' },
  jsx: 'transform',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  // The closure-factory handoff every `dsh.client` package's ./client export uses.
  banner: {
    js: `${banner}\nwindow.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
  plugins: [{
    name: 'client-purity',
    setup(build) {
      // A bare import the module table cannot answer is a guaranteed throw at load time.
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (PLATFORM_MODULES.includes(args.path) || args.kind === 'entry-point') return null
        return { errors: [{ text: `client bundle may only import ${PLATFORM_MODULES.join(', ')} from the host; got "${args.path}"` }] }
      })
    },
  }],
}

if (watch) {
  const contexts = await Promise.all([esbuild.context(host), esbuild.context(client)])
  await Promise.all(contexts.map(context => context.watch()))
  console.log('watching…')
} else {
  await Promise.all([esbuild.build(host), esbuild.build(client)])
}
