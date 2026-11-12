// Push the deployment-relevant variables from .env.local to the linked Vercel
// project, overwriting what is there. Values go over stdin, never on the command
// line or to the console. Run `npx vercel login` once first.
//
//   node scripts/vercel-env-push.mjs              # production
//   node scripts/vercel-env-push.mjs preview      # another environment
//   node scripts/vercel-env-push.mjs --dry-run    # list names only, change nothing
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Local-only settings stay on this machine: the port, the data folder, the dev
// operator token, and Redis (the serverless function runs uncached by design).
const LOCAL_ONLY = new Set(['PORT', 'DATA_DIR', 'ADMIN_TOKEN', 'REDIS_URL']);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const target = args.find((a) => !a.startsWith('--')) || 'production';

const vars = new Map();
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const l = line.trim();
  if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('=');
  if (i <= 0) continue;
  const key = l.slice(0, i).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || LOCAL_ONLY.has(key)) continue;
  let value = l.slice(i + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (value) vars.set(key, value); // last one wins, empty ones are skipped
}

let failed = 0;
for (const [key, value] of vars) {
  if (dryRun) { console.log('would push', key); continue; }
  const r = spawnSync('npx', ['-y', 'vercel@latest', 'env', 'add', key, target, '--force'], { input: value, encoding: 'utf8' });
  if (r.status === 0) console.log('pushed', key);
  else { failed++; console.log('FAILED', key, '-', (r.stderr || r.stdout || '').trim().split('\n').pop()); }
}
console.log(dryRun ? `${vars.size} variables would be pushed to ${target}` : `${vars.size - failed} of ${vars.size} pushed to ${target}`);
process.exit(failed ? 1 : 0);
