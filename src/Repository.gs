/**
 * Generic data-access layer over SpreadsheetApp. Every other module reads
 * and writes sheets through here so the rest of the codebase works with
 * named fields instead of magic column indices, and so batched
 * getValues()/setValues() calls (rather than per-cell access) are used
 * consistently everywhere.
 *
 * sheetKey is one of the SHEETS.* constants (which double as the actual
 * tab name), and COLUMNS[sheetKey] defines header order.
 */

var _headerIndexCache = {}; // reset per execution; Apps Script executions are single-threaded

function getSheet_(sheetKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetKey);
  if (!sheet) {
    throw new Error('Sheet not found: ' + sheetKey + ' (run Bootstrap.initializeSpreadsheet first)');
  }
  return sheet;
}

function getHeaderIndex_(sheetKey) {
  if (_headerIndexCache[sheetKey]) return _headerIndexCache[sheetKey];
  var columns = COLUMNS[sheetKey];
  var index = {};
  for (var i = 0; i < columns.length; i++) {
    index[columns[i]] = i; // zero-based, matches array position in a data row
  }
  _headerIndexCache[sheetKey] = index;
  return index;
}

function rowToObject_(sheetKey, rowArray) {
  var columns = COLUMNS[sheetKey];
  var obj = {};
  for (var i = 0; i < columns.length; i++) {
    obj[columns[i]] = normalizeCellValue_(rowArray[i]);
  }
  return obj;
}

/**
 * Sheets silently auto-converts date-looking strings (which is exactly what
 * we write for timestamps) into real Date objects on read-back. A raw Date
 * object nested inside an array of objects can silently break
 * google.script.run's client/server serialization (the call "succeeds" but
 * delivers null instead of throwing). So every value read from a sheet is
 * normalized back to a plain string here, at the single choke point all
 * reads go through, rather than leaking Date objects to every caller.
 */
function normalizeCellValue_(value) {
  if (value instanceof Date) {
    var isMidnight = value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0;
    return isMidnight ? toDateOnlyString(value) : toIsoString(value);
  }
  return value;
}

function objectToRow_(sheetKey, obj) {
  var columns = COLUMNS[sheetKey];
  var row = [];
  for (var i = 0; i < columns.length; i++) {
    var value = obj[columns[i]];
    row.push(value === undefined ? '' : value);
  }
  return row;
}

/** Reads all data rows (excluding header) as an array of plain objects. */
function getAllRows(sheetKey) {
  var sheet = getSheet_(sheetKey);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = COLUMNS[sheetKey].length;
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    rows.push(rowToObject_(sheetKey, values[i]));
  }
  return rows;
}

/** Returns {object, rowIndex} where rowIndex is the 1-based sheet row, or null if not found. */
function findRowById(sheetKey, idColumn, id) {
  var sheet = getSheet_(sheetKey);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var lastCol = COLUMNS[sheetKey].length;
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var idIdx = getHeaderIndex_(sheetKey)[idColumn];
  for (var i = 0; i < values.length; i++) {
    if (values[i][idIdx] === id) {
      return { object: rowToObject_(sheetKey, values[i]), rowIndex: i + 2 };
    }
  }
  return null;
}

/** Returns all rows where predicate(obj) is true. */
function findWhere(sheetKey, predicate) {
  var all = getAllRows(sheetKey);
  var matches = [];
  for (var i = 0; i < all.length; i++) {
    if (predicate(all[i])) matches.push(all[i]);
  }
  return matches;
}

function findOneWhere(sheetKey, predicate) {
  var all = getAllRows(sheetKey);
  for (var i = 0; i < all.length; i++) {
    if (predicate(all[i])) return all[i];
  }
  return null;
}

function appendRow(sheetKey, obj) {
  var sheet = getSheet_(sheetKey);
  sheet.appendRow(objectToRow_(sheetKey, obj));
  return obj;
}

/** Updates only the provided fields on the row identified by rowIndex (1-based, as returned by findRowById). */
function updateRowByIndex(sheetKey, rowIndex, partialObj) {
  var sheet = getSheet_(sheetKey);
  var headerIndex = getHeaderIndex_(sheetKey);
  var lastCol = COLUMNS[sheetKey].length;
  var range = sheet.getRange(rowIndex, 1, 1, lastCol);
  var current = range.getValues()[0];
  Object.keys(partialObj).forEach(function (key) {
    var idx = headerIndex[key];
    if (idx === undefined) throw new Error('Unknown column "' + key + '" for sheet ' + sheetKey);
    current[idx] = partialObj[key];
  });
  range.setValues([current]);
}

/** Convenience: find by id then update; throws if not found. */
function updateById(sheetKey, idColumn, id, partialObj) {
  var found = findRowById(sheetKey, idColumn, id);
  if (!found) throw new Error(sheetKey + ' row not found for ' + idColumn + '=' + id);
  updateRowByIndex(sheetKey, found.rowIndex, partialObj);
}
