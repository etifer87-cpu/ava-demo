/**
 * verify/access.mjs - the two boundary rules that no type checker enforces.
 *
 * These are the only assertions in the suite that read FILES rather than the database, and they
 * are here rather than in a lint config because both failures are silent at build time and
 * expensive at run time.
 *
 *   1. A route file exports handlers and route config, and nothing else. Contract section 7: all
 *      logic lives in lib/. An exported helper in a route file is a module boundary that the
 *      router does not police - it becomes an import target, the logic follows it, and the route
 *      quietly becomes the place where the rules live.
 *   2. No client component reaches a server-only module. `server-only` throws at build time when
 *      it is imported into a client bundle, which is exactly the protection wanted - but only for
 *      a DIRECT import. An indirect one, through a module that looks harmless, is what puts a
 *      database handle or a session secret into a bundle that is served to a browser. This check
 *      follows the import graph transitively.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCAFFOLD_ROOT } from '../lib/kit-seed.mjs';

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.js', '.jsx'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'db', 'deploy', 'automation', 'config']);

/** Route handlers the router itself calls. */
const HANDLER_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/** Route segment config the framework reads. */
const CONFIG_EXPORTS = new Set([
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion',
  'maxDuration', 'generateStaticParams', 'metadata', 'generateMetadata',
]);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), out);
    } else if (SOURCE_EXT.includes(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const rel = (file) => path.relative(SCAFFOLD_ROOT, file);

/** Import specifiers, from static imports, `export ... from` and dynamic import(). */
function importsOf(text) {
  const found = new Set();
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) found.add(m[1]);
  for (const m of text.matchAll(/(?:^|\n)\s*export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g)) found.add(m[1]);
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.add(m[1]);
  return [...found];
}

/** Resolves a local specifier to a file in the checkout, or null when it is a package. */
async function resolveLocal(specifier, fromFile, allFiles) {
  let base;
  if (specifier.startsWith('@/')) base = path.join(SCAFFOLD_ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  const candidates = [
    base,
    ...SOURCE_EXT.map((e) => base + e),
    ...SOURCE_EXT.map((e) => path.join(base, `index${e}`)),
  ];
  for (const candidate of candidates) if (allFiles.has(candidate)) return candidate;
  return null;
}

export const checks = [
  {
    name: 'route files export handlers and route config only',
    async run() {
      const files = (await walk(path.join(SCAFFOLD_ROOT, 'app')))
        .filter((f) => path.basename(f).startsWith('route.'));
      const problems = [];
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        const names = new Set();
        for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
        for (const m of text.matchAll(/^export\s+(?:const|let|var|class)\s+(\w+)/gm)) names.add(m[1]);
        for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
          for (const part of m[1].split(',')) {
            const name = part.split(/\s+as\s+/).pop().trim();
            if (name) names.add(name);
          }
        }
        if (/^export\s+default\b/m.test(text)) names.add('default');
        for (const name of names) {
          if (HANDLER_EXPORTS.has(name) || CONFIG_EXPORTS.has(name)) continue;
          problems.push(`${rel(file)} exports "${name}"`);
        }
      }
      return {
        ok: files.length > 0 && problems.length === 0,
        detail: files.length === 0 ? 'no route files found, which cannot be right'
          : problems.length === 0 ? `${files.length} route files, handlers and config only`
          : problems.join('; '),
      };
    },
  },
  {
    name: 'no client component imports a server-only module, directly or through another',
    async run() {
      const files = [
        ...(await walk(path.join(SCAFFOLD_ROOT, 'app'))),
        ...(await walk(path.join(SCAFFOLD_ROOT, 'components'))),
        ...(await walk(path.join(SCAFFOLD_ROOT, 'lib'))),
      ];
      const all = new Set(files);
      const text = new Map();
      for (const file of files) text.set(file, await readFile(file, 'utf8'));

      // The seed set: every module that imports 'server-only' itself.
      const serverOnly = new Set(
        files.filter((f) => importsOf(text.get(f)).includes('server-only')),
      );
      // Propagate: a module that imports a server-only module is server-only too. Run to a fixed
      // point, because the chain is what a direct check misses.
      const localImports = new Map();
      for (const file of files) {
        const resolved = [];
        for (const specifier of importsOf(text.get(file))) {
          const target = await resolveLocal(specifier, file, all);
          if (target) resolved.push(target);
        }
        localImports.set(file, resolved);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const file of files) {
          if (serverOnly.has(file)) continue;
          if (localImports.get(file).some((t) => serverOnly.has(t))) {
            serverOnly.add(file);
            changed = true;
          }
        }
      }

      const clients = files.filter((f) => /^\s*['"]use client['"]/m.test(text.get(f)));
      const problems = [];
      for (const client of clients) {
        if (serverOnly.has(client)) {
          problems.push(`${rel(client)} is a client component and is itself server-only`);
        }
        for (const target of localImports.get(client)) {
          if (serverOnly.has(target)) problems.push(`${rel(client)} -> ${rel(target)}`);
        }
      }
      return {
        ok: problems.length === 0,
        detail: problems.length === 0
          ? `${clients.length} client components, ${serverOnly.size} server-only modules, no crossing`
          : problems.join('; '),
      };
    },
  },
];
