/** One-shot manual deploy of frontend/dist to Netlify via API. No repo/state writes. */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const API = 'https://api.netlify.com/api/v1';
const token = process.env.NFP ?? '';
const distDir = new URL('../frontend/dist/', import.meta.url).pathname;
if (!token) throw new Error('NFP env var required');

async function collect(dir, base = '') {
  const out = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await collect(dir, rel));
    else out.push(rel);
  }
  return out;
}

const api = (path, init = {}) => fetch(`${API}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  signal: AbortSignal.timeout(60000),
});

// 1. Site (first free name wins).
let site = null;
for (const name of ['hackathon-finder', 'hackathon-finder-app', 'find-hackathons']) {
  const r = await api('/sites', { method: 'POST', body: JSON.stringify({ name }) });
  if (r.ok) { site = await r.json(); break; }
  const t = await r.text();
  console.log(`name ${name}: HTTP ${r.status} ${t.slice(0, 100)}`);
}
if (!site) throw new Error('site creation failed');
console.log('SITE', site.id, site.url, site.ssl_url);

// 2. Digest every file.
const files = await collect(distDir);
const digests = {};
for (const f of files) {
  const buf = await readFile(join(distDir, ...f.split('/')));
  digests['/' + f] = createHash('sha1').update(buf).digest('hex');
}
console.log('files:', files.length);

// 3. Create deploy.
let res = await api(`/sites/${site.id}/deploys`, { method: 'POST', body: JSON.stringify({ files: digests }) });
if (!res.ok) throw new Error('deploy create failed: ' + (await res.text()).slice(0, 200));
let deploy = await res.json();
console.log('DEPLOY', deploy.id, deploy.state);

// 4. Upload required files. NOTE: `required` lists SHA digests, not paths —
  // map each back to its local path first.
  const required: string[] = deploy.required ?? [];
  const shaToPath = new Map<string, string>();
  for (const [path, sha] of Object.entries(digests)) shaToPath.set(sha as string, path);
for (const sha of required) {
  const p = shaToPath.get(sha);
  if (!p) throw new Error(`unknown required digest ${sha}`);
  const buf = await readFile(join(distDir, ...p.replace(/^\//, '').split('/')));
  const up = await fetch(`${API}/deploys/${deploy.id}/files${p}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(120000),
    duplex: 'half',
  });
  if (!up.ok) throw new Error(`upload ${p} failed: ${up.status}`);
}
console.log('uploaded', required.length, 'files');

// 5. Poll to ready.
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const s = await (await api(`/deploys/${deploy.id}`)).json();
  console.log('state:', s.state);
  if (s.state === 'ready') {
    console.log('LIVE_URL', s.ssl_url || site.ssl_url);
    break;
  }
  if (s.state === 'error') {
    console.log('ERROR_STATE', JSON.stringify(s).slice(0, 400));
    break;
  }
}
