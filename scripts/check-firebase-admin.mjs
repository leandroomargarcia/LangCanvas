import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i);
    let v = line.slice(i + 1);
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = loadEnv('.env');
let pk = (env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
console.log(
  JSON.stringify({
    projectId: env.FIREBASE_PROJECT_ID,
    email: env.FIREBASE_CLIENT_EMAIL,
    keyLen: pk.length,
    begin: pk.slice(0, 27),
    end: pk.slice(-25),
  }),
);

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: pk,
    }),
  });
  const db = admin.firestore();
  const users = await db.collection('users').limit(1).get();
  const usage = await db.collection('usage').limit(1).get();
  console.log('OK', { users: users.size, usage: usage.size });
} catch (e) {
  console.log('FAIL', e.code || '', String(e.message || e).slice(0, 500));
  process.exitCode = 1;
}
