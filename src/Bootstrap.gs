/**
 * One-time setup helpers. Run these manually from the Apps Script editor
 * (select the function in the dropdown and click Run) — they are not
 * exposed to the web app UI.
 */

/**
 * Creates every sheet tab defined in COLUMNS with its header row, if it
 * doesn't already exist. Safe to re-run; it never touches an existing sheet.
 * Also seeds a default global interest rate so the app has something to
 * resolve on day one.
 */
function initializeSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(SHEETS).forEach(function (key) {
    var sheetName = SHEETS[key];
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      var headers = COLUMNS[sheetName];
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    }
  });

  // Remove the default blank "Sheet1" if it's still there and empty.
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0) {
    ss.deleteSheet(defaultSheet);
  }

  seedDefaultInterestRateIfMissing_();

  Logger.log('Spreadsheet initialized. Next: run createInitialAdmin() with your own values.');
}

function seedDefaultInterestRateIfMissing_() {
  var existing = findOneWhere(SHEETS.INTEREST_CONFIG, function (row) {
    return !row.EffectiveTo;
  });
  if (existing) return;

  appendRow(SHEETS.INTEREST_CONFIG, {
    ConfigId: newId('cfg'),
    GlobalAnnualRate: 0.03,
    EffectiveFrom: toDateOnlyString(nowDate()),
    EffectiveTo: '',
    SetBy: 'system',
    SetAt: toIsoString(nowDate())
  });
}

/**
 * Creates the very first admin account. There is a chicken-and-egg problem
 * for account creation (Auth.createAccount requires an authenticated admin
 * caller), so this bootstraps the first one directly. Edit the values below
 * and run this once, then delete/ignore it — subsequent kid/admin accounts
 * should be created via the Admin Dashboard (Auth.createAccount).
 */
function createInitialAdmin() {
  var username = 'parent';       // CHANGE ME before running
  var passcode = 'changeme123';  // CHANGE ME before running
  var displayName = 'Parent';
  var email = 'you@example.com'; // CHANGE ME before running

  var existing = findOneWhere(SHEETS.USERS, function (row) {
    return row.Username && row.Username.toLowerCase() === username.toLowerCase();
  });
  if (existing) {
    Logger.log('User "%s" already exists, skipping.', username);
    return;
  }

  var salt = Utilities.getUuid();
  var userId = newId('usr');

  appendRow(SHEETS.USERS, {
    UserId: userId,
    Username: username,
    DisplayName: displayName,
    Role: ROLE.ADMIN,
    PasscodeHash: hashPasscode_(passcode, salt),
    PasscodeSalt: salt,
    Status: USER_STATUS.ACTIVE,
    StatementFrequency: STATEMENT_FREQUENCY.NONE,
    StatementDay: '',
    Email: email,
    CreatedAt: toIsoString(nowDate()),
    CreatedBy: 'system',
    Avatar: '👑',
    Theme: ''
  });

  Logger.log('Admin user "%s" created. Log in with the passcode you set in createInitialAdmin().', username);
}

/**
 * Temporary diagnostic: dumps the raw Transactions sheet + Users list to the
 * execution log, to check for header/column drift or UserId mismatches when
 * transactions aren't showing up as expected in the UI. Safe to run anytime;
 * read-only. Remove once the underlying issue is found.
 */
function debugDumpTransactions() {
  var sheet = getSheet_(SHEETS.TRANSACTIONS);
  Logger.log('Sheet name: %s, lastRow: %s, lastColumn: %s', sheet.getName(), sheet.getLastRow(), sheet.getLastColumn());

  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Logger.log('Header row (actual sheet): %s', JSON.stringify(headerRow));
  Logger.log('Expected COLUMNS.Transactions: %s', JSON.stringify(COLUMNS[SHEETS.TRANSACTIONS]));

  var rows = getAllRows(SHEETS.TRANSACTIONS);
  Logger.log('Parsed transaction row count: %s', rows.length);
  rows.forEach(function (row, i) {
    Logger.log('Transaction row %s: %s', i, JSON.stringify(row));
  });

  var users = getAllRows(SHEETS.USERS);
  Logger.log('Users: %s', JSON.stringify(users.map(function (u) {
    return { UserId: u.UserId, Username: u.Username, Role: u.Role, Status: u.Status };
  })));
}
