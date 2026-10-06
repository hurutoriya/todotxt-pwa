// ローカルファイル参照レイヤー
// - File System Access API (showOpenFilePicker) があれば上書き保存まで対応
// - なければ <input type=file> + ダウンロード保存のフォールバック
// - ハンドルは IndexedDB に保存し、起動時の「最近使ったファイル」から再選択できる

export const supportsFS = typeof window !== "undefined" && "showOpenFilePicker" in window;

const DB = "todotxt-pwa";
const STORE = "handles";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const q = tx.objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

/** ジェスチャなしで許可状態だけを確認する（起動時自動復元用。プロンプトは出さない） */
export async function queryGranted(handle, write = false) {
  if (!handle?.queryPermission) return false;
  try {
    return (await handle.queryPermission(write ? { mode: "readwrite" } : {})) === "granted";
  } catch {
    return false;
  }
}

const SNAP_KEY = "todotxt-pwa:snapshot";

/** 編集中内容のスナップショットをブラウザ内(localStorage)に同期・永続化。
    閉じても次回起動時に復元される。pagehide時も確実に書けるよう同期的APIを使う */
export function saveContentSnapshot(name, text) {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({ name, text, updatedAt: Date.now() }));
  } catch { /* quota超過等は無視 */ }
}

export function loadContentSnapshot() {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 明示的にファイルを閉じたときはスナップショットも破棄する */
export function clearContentSnapshot() {
  try {
    localStorage.removeItem(SNAP_KEY);
  } catch { /* ignore */ }
}

export async function verifyPermission(handle, write = false) {
  if (!handle?.queryPermission) return true;
  const mode = write ? { mode: "readwrite" } : {};
  if ((await handle.queryPermission(mode)) === "granted") return true;
  return (await handle.requestPermission(mode)) === "granted";
}

export async function pickFile() {
  const [handle] = await window.showOpenFilePicker({
    types: [{ description: "todo.txt", accept: { "text/plain": [".txt"] } }],
    multiple: false,
  });
  await verifyPermission(handle, false);
  // 書き込み権限は「開く」操作中(ユーザー操作中)に取得するのが必須。
  // デバウンス後の自動保存からは権限プロンプトを出せないため、後回しにすると保存が失敗する
  const writable = await verifyPermission(handle, true);
  const file = await handle.getFile();
  const text = await file.text();
  await rememberHandle(handle, file.name);
  return { handle, name: file.name, text, lastModified: file.lastModified, writable };
}

export async function createFile(suggestedName = "todo.txt") {
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{ description: "todo.txt", accept: { "text/plain": [".txt"] } }],
  });
  await verifyPermission(handle, true);
  await rememberHandle(handle, handle.name ?? suggestedName);
  return { handle, name: handle.name ?? suggestedName, text: "", lastModified: Date.now() };
}

export async function readHandle(handle) {
  // 読み取りと同時に書き込み権限も確保する。操作起点(クリック等)から呼ばれれば
  // プロンプトを出せるため、以降の自動保存が原本へ届く。操作外では拒否されるが
  // 呼び出し側で捕捉されるため安全
  await verifyPermission(handle, true);
  const file = await handle.getFile();
  return { name: file.name, text: await file.text(), lastModified: file.lastModified };
}

export async function writeHandle(handle, text) {
  await verifyPermission(handle, true);
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

async function rememberHandle(handle, name) {
  try {
    const recents = (await idbGet("recents")) ?? [];
    const next = [{ name, savedAt: Date.now() }, ...recents.filter((r) => r.name !== name)].slice(0, 5);
    await idbSet("recents", next);
    // ハンドル本体は名前キーで保存（複数ファイル対応）。最新は "lastName" で指す。
    await idbSet("handle:" + name, handle);
    await idbSet("lastName", name);
  } catch { /* private mode 等では無視 */ }
}

export async function getRecents() {
  try { return (await idbGet("recents")) ?? []; } catch { return []; }
}

export async function getStoredHandle(name) {
  try {
    const key = name ?? (await idbGet("lastName"));
    if (!key) return null;
    const h = await idbGet("handle:" + key);
    return h ? { handle: h, name: key } : null;
  } catch { return null; }
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename || "todo.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
