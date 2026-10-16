// `npm run dev`: wrangler dev that only reloads when an app file changes.
//
// wrangler watches its whole assets directory, and ours is the repo root, so
// any write (NOTES.md, qa/shots, another session's edits) used to reload the
// worker and drop every socket. Here wrangler serves a mirror of the deployable
// files instead (everything .assetsignore lets through), kept in sync from the
// repo. Writes to ignored files never reach the mirror, so they don't reload.
// Deploys are unchanged: `wrangler deploy` still uploads "." per wrangler.toml.
//
// Extra args go to wrangler: `npm run dev -- --port 8790`.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, readdirSync, statSync, watch } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = join(ROOT, 'node_modules', '.cache', 'skull-dev-assets');

// .assetsignore, gitignore-style but only what we use: `name`, `dir/`, `*` globs.
const rules = readFileSync(join(ROOT, '.assetsignore'), 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => {
    const dirOnly = l.endsWith('/');
    const pat = l.replace(/\/$/, '').replace(/^\//, '');
    const re = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
    return { re, dirOnly, anchored: pat.includes('/') };
  });

function ignored(rel, isDir) {
  const parts = rel.split(sep);
  return rules.some(({ re, dirOnly, anchored }) => {
    if (anchored) return re.test(parts.join('/'));
    // A segment matches; a dir-only rule must match a parent dir (or this dir).
    return parts.some((seg, i) => re.test(seg) && (!dirOnly || i < parts.length - 1 || isDir));
  });
}

function sameFile(a, b) {
  try {
    return statSync(b).size === statSync(a).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function syncFile(rel) {
  const src = join(ROOT, rel);
  const dst = join(MIRROR, rel);
  let st = null;
  try { st = statSync(src); } catch { /* deleted */ }
  if (!st) {
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(src)) {
      const r = join(rel, name);
      if (!ignored(r, statSync(join(ROOT, r)).isDirectory())) syncFile(r);
    }
    return;
  }
  if (sameFile(src, dst)) return;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

rmSync(MIRROR, { recursive: true, force: true });
mkdirSync(MIRROR, { recursive: true });
for (const name of readdirSync(ROOT)) {
  if (!ignored(name, statSync(join(ROOT, name)).isDirectory())) syncFile(name);
}

const pending = new Set();
let timer = null;
const watcher = watch(ROOT, { recursive: true }, (_event, file) => {
  if (!file) return;
  const rel = relative(ROOT, join(ROOT, file.toString()));
  if (rel.startsWith('..') || ignored(rel, false)) return;
  pending.add(rel);
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const r of pending) {
      try { syncFile(r); } catch (e) { console.warn(`[dev] sync ${r}: ${e.message}`); }
    }
    pending.clear();
  }, 100);
});

const bin = join(ROOT, 'node_modules', '.bin', 'wrangler');
const child = spawn(bin, ['dev', '--assets', MIRROR, ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => {
  watcher.close();
  process.exit(code ?? (signal ? 1 : 0));
});
