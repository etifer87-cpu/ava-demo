#!/usr/bin/env node
/**
 * neutrality-scan.mjs - the gate that keeps this repository free of material from any other
 * engagement. Specified by docs/01_ISOLATION.md ("The neutrality gate") and CLAUDE.md rule 2.
 *
 * Reads a word list from NEUTRALITY_WORDLIST - a path OUTSIDE this repository, by design: a list of
 * forbidden strings kept inside the repo would itself be a mention. Walks every text file in the
 * repository and fails, non-zero, on the first file that contains any listed word or phrase,
 * matched case-insensitively as a whole word. There is no exception list and there never may be;
 * the fix for a hit is removal.
 *
 * Usage:
 *   node --env-file=.env scripts/neutrality-scan.mjs            scan the repository root (parent of scaffold/)
 *   node --env-file=.env scripts/neutrality-scan.mjs --root .   scan another root
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argRoot = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : null;
const root = path.resolve(argRoot ?? path.join(here, '..', '..'));

const listPath = process.env.NEUTRALITY_WORDLIST;
if (!listPath) {
  console.error('NEUTRALITY_WORDLIST is not set. It must point to a word list OUTSIDE this repository.');
  process.exit(2);
}
if (path.resolve(listPath).startsWith(root + path.sep)) {
  console.error(`NEUTRALITY_WORDLIST resolves inside the repository (${listPath}). Move it out.`);
  process.exit(2);
}

const words = readFileSync(listPath, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
if (words.length === 0) {
  console.error(`Word list at ${listPath} is empty. An empty gate is not a gate.`);
  process.exit(2);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const patterns = words.map((w) => ({ word: w, re: new RegExp(`(?<![\\p{L}\\p{N}_])${escape(w)}(?![\\p{L}\\p{N}_])`, 'iu') }));

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'data', 'Media', 'coverage', '.vitest', 'out', 'dist']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.ai', '.zip', '.gz', '.dump', '.lock']);

const hits = [];
let scanned = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full);
      continue;
    }
    if (SKIP_EXT.has(path.extname(name).toLowerCase()) || st.size > 5_000_000) continue;
    scanned += 1;
    const text = readFileSync(full, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const { word, re } of patterns) {
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) {
          hits.push({ file: path.relative(root, full), line: i + 1, word });
          break; // one report per word per file is enough to fail
        }
      }
    }
  }
}

walk(root);

if (hits.length) {
  console.error(`NEUTRALITY SCAN FAILED - ${hits.length} hit(s) in ${scanned} files under ${root}`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  contains "${h.word}"`);
  console.error('The fix is removal. There is no exception list.');
  process.exit(1);
}
console.log(`neutrality scan: ${scanned} files, ${words.length} terms, 0 hits`);
