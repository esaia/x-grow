/**
 * A very small promise wrapper over IndexedDB.
 *
 * Deliberately dependency-free. The one rule callers must respect: inside a
 * `run()` callback you may only await IDB request promises. Awaiting anything
 * else (a fetch, a chrome.* call, a timer) hands control back to the event loop
 * and IndexedDB auto-commits the transaction out from under you.
 */

export const DB_NAME = 'xgrow';
export const DB_VERSION = 1;

export const STORE = {
  voiceProfile: 'voiceProfile',
  generations: 'generations',
  scheduledPosts: 'scheduledPosts',
  creators: 'creators',
  inspirationPosts: 'inspirationPosts',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let connection: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => {
        // A version change from another context (say, an extension reload)
        // would otherwise block forever behind this handle.
        request.result.onversionchange = () => {
          request.result.close();
          connection = null;
        };

        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error('X-Grow database is blocked by another tab.'));
    }).catch((error) => {
      connection = null;
      throw error;
    });
  }

  return connection;
}

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE.voiceProfile)) {
    // Out-of-line key; there is only ever one record, at key 1.
    db.createObjectStore(STORE.voiceProfile);
  }

  if (!db.objectStoreNames.contains(STORE.generations)) {
    const store = db.createObjectStore(STORE.generations, {
      keyPath: 'id',
      autoIncrement: true,
    });

    store.createIndex('type', 'type');
    store.createIndex('created_at', 'created_at');
    // Replaces the platform's POST /generate/recent lookup.
    store.createIndex('input_context', 'input_context');
  }

  if (!db.objectStoreNames.contains(STORE.scheduledPosts)) {
    const store = db.createObjectStore(STORE.scheduledPosts, {
      keyPath: 'id',
      autoIncrement: true,
    });

    store.createIndex('status', 'status');
    store.createIndex('scheduled_at', 'scheduled_at');
  }

  if (!db.objectStoreNames.contains(STORE.creators)) {
    db.createObjectStore(STORE.creators, { keyPath: 'username' });
  }

  if (!db.objectStoreNames.contains(STORE.inspirationPosts)) {
    const store = db.createObjectStore(STORE.inspirationPosts, {
      keyPath: ['username', 'x_tweet_id'],
    });

    store.createIndex('username', 'username');
    store.createIndex('baseline_multiplier', 'baseline_multiplier');
  }
}

/** Promisify a single IDBRequest. */
export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run `fn` inside a transaction and resolve once it has actually committed —
 * so a caller that awaits `run()` knows the write is durable.
 */
export async function run<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(stores, mode);

  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error('X-Grow database transaction aborted.'));
  });

  let result: T;

  try {
    result = await fn(tx);
  } catch (error) {
    // A caller-thrown error should not leave a half-applied write behind.
    try {
      tx.abort();
    } catch {
      // Already finished; nothing to roll back.
    }

    throw error;
  }

  await committed;

  return result;
}

/** Read every record from a store or index, newest-agnostic. */
export function all<T>(source: IDBObjectStore | IDBIndex): Promise<T[]> {
  return req(source.getAll() as IDBRequest<T[]>);
}
