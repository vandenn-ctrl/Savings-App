/**
 * Shared helpers used across server modules and statement templates.
 */

function newId(prefix) {
  return prefix + '_' + Utilities.getUuid();
}

function nowDate() {
  return new Date();
}

function toIsoString(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function toDateOnlyString(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDays(date, days) {
  var result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function daysBetween(from, to) {
  var msPerDay = 24 * 60 * 60 * 1000;
  var fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  var toMidnight = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toMidnight.getTime() - fromMidnight.getTime()) / msPerDay);
}

function lastDayOfMonth(year, monthIndexZeroBased) {
  return new Date(year, monthIndexZeroBased + 1, 0).getDate();
}

/**
 * Sheets tends to auto-convert date-looking strings written to a cell into
 * real Date objects on read-back. These two helpers normalize either shape
 * (Date object or string) into the form callers need, so date comparisons
 * don't silently break depending on how a given cell happened to format.
 */
function toDateObject_(value) {
  return value instanceof Date ? value : new Date(value);
}

function normalizeDateOnlyString_(value) {
  if (!value) return '';
  return value instanceof Date ? toDateOnlyString(value) : String(value);
}

function formatCurrency(amount) {
  var value = (Math.round((amount || 0) * 100) / 100).toFixed(2);
  return '$' + value;
}

function roundMoney(amount) {
  return Math.round((amount || 0) * 100) / 100;
}

/**
 * Wraps a function call, converting any thrown error into a plain
 * {error: message} object so google.script.run failure handlers in the
 * client always receive a consistent shape.
 */
function safeInvoke(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/** Server-side HTML escaping for text embedded in generated email bodies. */
function escapeHtmlServer_(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** Appends a row to AuditLog. details is a plain object, stored as a JSON string. */
function logAudit_(actorUserId, action, targetType, targetId, details) {
  appendRow(SHEETS.AUDIT_LOG, {
    LogId: newId('log'),
    Timestamp: toIsoString(nowDate()),
    ActorUserId: actorUserId,
    Action: action,
    TargetType: targetType,
    TargetId: targetId,
    Details: JSON.stringify(details || {})
  });
}
