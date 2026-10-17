import type { TaskMutation } from "@vela/shared";

const DB_NAME = "keepx";
const STORE = "mutations";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

export function readMutations(): Promise<TaskMutation[]> {
  return run<TaskMutation[]>("readonly", (store) => store.getAll());
}

export function writeMutation(record: TaskMutation): Promise<void> {
  return run("readwrite", (store) => store.put(record)).then(() => undefined);
}

export function deleteMutation(id: string): Promise<void> {
  return run("readwrite", (store) => store.delete(id)).then(() => undefined);
}
