// Lokálna databáza v zariadení (IndexedDB). Zatiaľ jediné úložisko dát.
const NAME = 'pokladna';
const STORE = 'receipts';

let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('receiptId', 'receiptId', { unique: false });
      s.createIndex('createdAt', 'createdAt', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const all = async () => (await run('readonly', (s) => s.getAll())).sort((a, b) => b.createdAt - a.createdAt);
export const get = (id) => run('readonly', (s) => s.get(id));
export const put = (r) => run('readwrite', (s) => s.put(r));
export const del = (id) => run('readwrite', (s) => s.delete(id));
export const findByReceiptId = (rid) => run('readonly', (s) => s.index('receiptId').get(rid));
