/**
 * Backing store for login sessions. CacheService is a fast-path in front of
 * the durable Sessions sheet — cache entries can be evicted early or expire
 * after at most 6 hours (a hard CacheService limit), so the sheet is always
 * consulted on a cache miss and is the real source of truth.
 */

function cacheKeyForToken_(token) {
  return 'sess_' + token;
}

function putSession(token, userId) {
  var now = nowDate();
  var expiresAt = new Date(now.getTime() + CONFIG.SESSION_TTL_HOURS * 60 * 60 * 1000);

  appendRow(SHEETS.SESSIONS, {
    Token: token,
    UserId: userId,
    CreatedAt: toIsoString(now),
    ExpiresAt: toIsoString(expiresAt),
    LastSeenAt: toIsoString(now)
  });

  CacheService.getScriptCache().put(
    cacheKeyForToken_(token),
    JSON.stringify({ userId: userId, expiresAt: expiresAt.getTime() }),
    CONFIG.CACHE_TTL_SECONDS
  );
}

/** Returns { userId, expiresAt, rowIndex } or null if missing/expired. rowIndex is only populated on a sheet lookup. */
function getSession(token) {
  var cached = CacheService.getScriptCache().get(cacheKeyForToken_(token));
  if (cached) {
    var parsed = JSON.parse(cached);
    if (parsed.expiresAt > Date.now()) {
      return { userId: parsed.userId, expiresAt: new Date(parsed.expiresAt), rowIndex: null };
    }
    // Cached but expired — fall through to sheet check in case it was refreshed elsewhere.
  }

  var found = findRowById(SHEETS.SESSIONS, 'Token', token);
  if (!found) return null;

  var expiresAt = new Date(found.object.ExpiresAt);
  if (expiresAt.getTime() <= Date.now()) return null;

  // Repopulate the cache for the remaining TTL (capped at CACHE_TTL_SECONDS).
  var remainingSeconds = Math.min(CONFIG.CACHE_TTL_SECONDS, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  if (remainingSeconds > 0) {
    CacheService.getScriptCache().put(
      cacheKeyForToken_(token),
      JSON.stringify({ userId: found.object.UserId, expiresAt: expiresAt.getTime() }),
      remainingSeconds
    );
  }

  return { userId: found.object.UserId, expiresAt: expiresAt, rowIndex: found.rowIndex };
}

/** Extends the session's expiry if it's been more than the touch threshold since last seen. Best-effort; skips the sheet write when not needed to avoid hammering it on every call. */
function touchSession(token, session) {
  var now = nowDate();
  var newExpiresAt = new Date(now.getTime() + CONFIG.SESSION_TTL_HOURS * 60 * 60 * 1000);

  CacheService.getScriptCache().put(
    cacheKeyForToken_(token),
    JSON.stringify({ userId: session.userId, expiresAt: newExpiresAt.getTime() }),
    CONFIG.CACHE_TTL_SECONDS
  );

  var found = findRowById(SHEETS.SESSIONS, 'Token', token);
  if (!found) return;
  var lastSeen = new Date(found.object.LastSeenAt);
  var minutesSinceSeen = (now.getTime() - lastSeen.getTime()) / (60 * 1000);
  if (minutesSinceSeen < CONFIG.SESSION_TOUCH_THRESHOLD_MINUTES) return;

  updateRowByIndex(SHEETS.SESSIONS, found.rowIndex, {
    ExpiresAt: toIsoString(newExpiresAt),
    LastSeenAt: toIsoString(now)
  });
}

function revokeSession(token) {
  CacheService.getScriptCache().remove(cacheKeyForToken_(token));
  var found = findRowById(SHEETS.SESSIONS, 'Token', token);
  if (found) {
    updateRowByIndex(SHEETS.SESSIONS, found.rowIndex, { ExpiresAt: toIsoString(nowDate()) });
  }
}

/** Called from a daily trigger to keep the Sessions sheet from growing unbounded. */
function purgeExpiredSessions() {
  var sheet = getSheet_(SHEETS.SESSIONS);
  var all = getAllRows(SHEETS.SESSIONS);
  var now = Date.now();
  // Walk bottom-up so deleting a row doesn't shift indices of rows not yet visited.
  for (var i = all.length - 1; i >= 0; i--) {
    var expiresAt = new Date(all[i].ExpiresAt).getTime();
    if (expiresAt <= now) {
      sheet.deleteRow(i + 2); // +2: 1-based rows, +1 for header
    }
  }
}
