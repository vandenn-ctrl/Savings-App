/**
 * Authentication: custom username + access-code (PIN) login, since family
 * members do not have Google accounts to sign in with. Passcodes are stored
 * as a salted SHA-256 digest (Utilities.computeDigest) rather than in the
 * clear. This is a deliberately pragmatic choice, not bank-grade crypto:
 * Apps Script has no slow KDF (bcrypt/PBKDF2) available, and the underlying
 * Sheet is already access-controlled via Drive sharing permissions, so a
 * salted SHA-256 hash is an acceptable trade-off for a private family app.
 */

function hashPasscode_(passcode, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + passcode);
  return Utilities.base64Encode(digest);
}

/** Throws if the token is missing/expired; otherwise returns the full user row. */
function validateSession(token) {
  if (!token) throw new Error('Not logged in.');
  var session = getSession(token);
  if (!session) throw new Error('Session expired. Please log in again.');

  var userRow = findRowById(SHEETS.USERS, 'UserId', session.userId);
  if (!userRow || userRow.object.Status !== USER_STATUS.ACTIVE) {
    throw new Error('Account not found or disabled.');
  }

  touchSession(token, session);
  return userRow.object;
}

function requireAdmin_(user) {
  if (user.Role !== ROLE.ADMIN) throw new Error('Admin access required.');
}

/**
 * Logs a user in by username + passcode. Returns { token, userId, role, displayName }.
 */
function login(username, passcode) {
  var user = findOneWhere(SHEETS.USERS, function (row) {
    return row.Username && row.Username.toLowerCase() === String(username || '').toLowerCase();
  });

  if (!user || user.Status !== USER_STATUS.ACTIVE) {
    throw new Error('Invalid username or passcode.');
  }

  var computedHash = hashPasscode_(passcode, user.PasscodeSalt);
  if (computedHash !== user.PasscodeHash) {
    throw new Error('Invalid username or passcode.');
  }

  var token = Utilities.getUuid();
  putSession(token, user.UserId);

  return { token: token, userId: user.UserId, role: user.Role, displayName: user.DisplayName };
}

function logout(token) {
  revokeSession(token);
  return { ok: true };
}

/**
 * Admin-only: creates a new family member account (kid or another admin).
 */
function createAccount(token, params) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  var username = String(params.username || '').trim();
  var passcode = String(params.passcode || '');
  var role = params.role === ROLE.ADMIN ? ROLE.ADMIN : ROLE.KID;

  if (!username || !passcode) throw new Error('Username and passcode are required.');

  var existing = findOneWhere(SHEETS.USERS, function (row) {
    return row.Username && row.Username.toLowerCase() === username.toLowerCase();
  });
  if (existing) throw new Error('That username is already taken.');

  var salt = Utilities.getUuid();
  var userId = newId('usr');

  appendRow(SHEETS.USERS, {
    UserId: userId,
    Username: username,
    DisplayName: params.displayName || username,
    Role: role,
    PasscodeHash: hashPasscode_(passcode, salt),
    PasscodeSalt: salt,
    Status: USER_STATUS.ACTIVE,
    StatementFrequency: params.statementFrequency || STATEMENT_FREQUENCY.NONE,
    StatementDay: params.statementDay || '',
    Email: params.email || '',
    CreatedAt: toIsoString(nowDate()),
    CreatedBy: admin.UserId
  });

  if (role === ROLE.KID) {
    appendRow(SHEETS.ACCOUNTS, {
      AccountId: newId('acc'),
      UserId: userId,
      AccountType: ACCOUNT_TYPE.SAVINGS,
      CashBalance: 0,
      InterestRateOverride: '',
      LastAccrualDate: toDateOnlyString(nowDate())
    });
    appendRow(SHEETS.ACCOUNTS, {
      AccountId: newId('acc'),
      UserId: userId,
      AccountType: ACCOUNT_TYPE.INVESTMENT,
      CashBalance: 0,
      InterestRateOverride: '',
      LastAccrualDate: toDateOnlyString(nowDate())
    });
  }

  logAudit_(admin.UserId, 'CREATE_ACCOUNT', 'User', userId, { username: username, role: role });

  return { userId: userId };
}

function changePasscode(token, oldPasscode, newPasscode) {
  var user = validateSession(token);
  var computedHash = hashPasscode_(oldPasscode, user.PasscodeSalt);
  if (computedHash !== user.PasscodeHash) throw new Error('Current passcode is incorrect.');
  if (!newPasscode) throw new Error('New passcode is required.');

  var newSalt = Utilities.getUuid();
  updateById(SHEETS.USERS, 'UserId', user.UserId, {
    PasscodeHash: hashPasscode_(newPasscode, newSalt),
    PasscodeSalt: newSalt
  });

  return { ok: true };
}

/** Admin-only: reset a family member's passcode (e.g. they forgot it). */
function resetPasscode(token, targetUserId, newPasscode) {
  var admin = validateSession(token);
  requireAdmin_(admin);
  if (!newPasscode) throw new Error('New passcode is required.');

  var newSalt = Utilities.getUuid();
  updateById(SHEETS.USERS, 'UserId', targetUserId, {
    PasscodeHash: hashPasscode_(newPasscode, newSalt),
    PasscodeSalt: newSalt
  });

  logAudit_(admin.UserId, 'RESET_PASSCODE', 'User', targetUserId, {});
  return { ok: true };
}

function setUserStatus(token, targetUserId, status) {
  var admin = validateSession(token);
  requireAdmin_(admin);
  if (status !== USER_STATUS.ACTIVE && status !== USER_STATUS.DISABLED) {
    throw new Error('Invalid status.');
  }
  updateById(SHEETS.USERS, 'UserId', targetUserId, { Status: status });
  logAudit_(admin.UserId, 'SET_USER_STATUS', 'User', targetUserId, { status: status });
  return { ok: true };
}
