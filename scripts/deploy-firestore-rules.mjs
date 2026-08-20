// Deploy firestore.rules using the Admin service account in .env
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JWT } from 'google-auth-library';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(path) {
  const out = {};
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val.replace(/\\n/g, '\n');
  }
  return out;
}

const env = loadEnv(resolve(root, '.env'));
const projectId = env.FIREBASE_PROJECT_ID;
const email = env.FIREBASE_CLIENT_EMAIL;
const key = env.FIREBASE_PRIVATE_KEY;
if (!projectId || !email || !key) {
  console.error('Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in .env');
  process.exit(1);
}

const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');
const jwt = new JWT({
  email,
  key,
  scopes: [
    'https://www.googleapis.com/auth/firebase',
    'https://www.googleapis.com/auth/cloud-platform',
  ],
});
const { access_token } = await jwt.authorize();
const headers = {
  Authorization: 'Bearer ' + access_token,
  'Content-Type': 'application/json',
};

const created = await fetch(`https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    source: { files: [{ name: 'firestore.rules', content: rules }] },
  }),
});
const createdBody = await created.json();
if (!created.ok) {
  console.error('Create ruleset failed:', created.status, JSON.stringify(createdBody));
  process.exit(1);
}

const releaseName = `projects/${projectId}/releases/cloud.firestore`;
const released = await fetch(`https://firebaserules.googleapis.com/v1/${releaseName}?updateMask=rulesetName`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({
    release: {
      name: releaseName,
      rulesetName: createdBody.name,
    },
  }),
});
const releasedBody = await released.json();
if (!released.ok) {
  console.error('Publish release failed:', released.status, JSON.stringify(releasedBody));
  process.exit(1);
}

console.log('Published Firestore rules:', createdBody.name);
