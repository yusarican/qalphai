import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

/** Service account JSON'un yolu. Goreli verilirse repo kokune gore cozulur. */
const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'serviceaccount.json';

function serviceAccountFile(): string {
  return path.resolve(process.cwd(), SERVICE_ACCOUNT_PATH);
}

function loadServiceAccount(): admin.ServiceAccount {
  const file = serviceAccountFile();
  if (!fs.existsSync(file)) {
    throw new Error(
      `Firebase service account dosyasi yok: ${file}\n` +
        `Firebase Console > Project Settings > Service accounts > Generate new private key ile indirip ` +
        `repo kokune 'serviceaccount.json' olarak koy (veya .env'de FIREBASE_SERVICE_ACCOUNT_PATH ile yolu ver).`,
    );
  }

  let json: { project_id?: string; client_email?: string; private_key?: string };
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Firebase service account dosyasi gecerli JSON degil: ${file} — ${(err as Error).message}`);
  }

  const missing = (['project_id', 'client_email', 'private_key'] as const).filter((k) => !json[k]);
  if (missing.length > 0) {
    throw new Error(`Firebase service account dosyasinda eksik alan(lar): ${missing.join(', ')} — ${file}`);
  }

  return {
    projectId: json.project_id,
    clientEmail: json.client_email,
    privateKey: json.private_key,
  };
}

/** Firebase yapilandirilmis mi (dosya var mi)? Opsiyonel yollarda once bunu sor. */
export function isFirebaseConfigured(): boolean {
  return fs.existsSync(serviceAccountFile());
}

/**
 * Firestore istemcisi. Ilk cagriya kadar hicbir sey okunmaz/baglanmaz — Firebase
 * kullanmayan komutlar (backtest, parity, gece dongusu) dosya yokken de calisir.
 */
export function getDb(): admin.firestore.Firestore {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  }
  return admin.firestore();
}

export const firebaseAdmin = admin;
