'use strict';

/**
 * In-memory TTL cache untuk /api/license/verify
 * 
 * - Tidak pakai external lib (pure Map + setTimeout)
 * - TTL default: 30 detik
 * - Max entries: 20.000 (cegah OOM kalau username unik terlalu banyak)
 * - Key: "username:scriptCode"
 * - Invalidasi otomatis saat admin revoke/unrevoke/edit expired
 */

const TTL_MS = 30 * 1000;   // 30 detik
const MAX_ENTRIES = 20_000;

// Map<key, { value, expiresAt }>
const store = new Map();

function makeKey(username, scriptCode) {
  return `${username.toLowerCase()}:${scriptCode.toUpperCase()}`;
}

/**
 * Ambil nilai dari cache.
 * Return null kalau tidak ada atau sudah expired.
 */
function get(username, scriptCode) {
  const key = makeKey(username, scriptCode);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Simpan nilai ke cache.
 */
function set(username, scriptCode, value) {
  const key = makeKey(username, scriptCode);

  // Kalau sudah penuh, buang entry paling lama (first inserted)
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }

  store.set(key, {
    value,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Invalidasi 1 entry spesifik.
 * Dipanggil saat admin revoke/unrevoke/edit expired/ganti username.
 */
function invalidate(username, scriptCode) {
  if (scriptCode) {
    store.delete(makeKey(username, scriptCode));
  } else {
    // Invalidasi semua entry milik username ini (kalau scriptCode tidak diketahui)
    const prefix = username.toLowerCase() + ':';
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  }
}

/**
 * Flush semua cache (pakai kalau ada perubahan besar).
 */
function flush() {
  store.clear();
}

/**
 * Stats untuk debug/monitoring.
 */
function stats() {
  return { size: store.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}

// Cleanup expired entries setiap 2 menit (housekeeping ringan)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 2 * 60 * 1000).unref(); // .unref() biar tidak block process exit

module.exports = { get, set, invalidate, flush, stats };
