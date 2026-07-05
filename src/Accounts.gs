/**
 * Account/user management (admin) and dashboard summary reads (kid + admin).
 */

function getAccountForUser_(userId, accountType) {
  var found = findOneWhere(SHEETS.ACCOUNTS, function (row) {
    return row.UserId === userId && row.AccountType === accountType;
  });
  if (!found) throw new Error('No ' + accountType + ' account found for user ' + userId);
  return found;
}

/** Admin-only: list all family members with high-level status info. */
function listUsers(token) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  return findWhere(SHEETS.USERS, function () { return true; }).map(function (u) {
    return {
      userId: u.UserId,
      username: u.Username,
      displayName: u.DisplayName,
      role: u.Role,
      status: u.Status,
      email: u.Email,
      statementFrequency: u.StatementFrequency,
      statementDay: u.StatementDay,
      avatar: u.Avatar || DEFAULT_AVATAR
    };
  });
}

/** Builds the balances/holdings/interest summary shared by getMyDashboard and getUserSummary. */
function buildDashboardSummary_(user) {
  var savings = getAccountForUser_(user.UserId, ACCOUNT_TYPE.SAVINGS);
  var rate = getCurrentRate(user.UserId);
  var accruedToday = computeAccruedInterest(savings.AccountId, nowDate());
  var holdings = getHoldingsForUser_(user.UserId);

  var holdingsValue = holdings.reduce(function (sum, h) { return sum + h.marketValue; }, 0);
  var savingsBalance = Number(savings.CashBalance) || 0;

  return {
    displayName: user.DisplayName,
    avatar: user.Avatar || DEFAULT_AVATAR,
    savings: {
      cashBalance: savingsBalance,
      accruedInterestToday: roundMoney(accruedToday),
      annualRate: rate
    },
    holdings: holdings,
    holdingsValue: roundMoney(holdingsValue),
    netWorth: roundMoney(savingsBalance + holdingsValue),
    statementFrequency: user.StatementFrequency,
    statementDay: user.StatementDay
  };
}

/** Kid (or admin viewing their own account): full dashboard summary. */
function getMyDashboard(token) {
  var user = validateSession(token);
  return buildDashboardSummary_(user);
}

/** Admin-only: view any kid's full dashboard summary. */
function getUserSummary(token, targetUserId) {
  var admin = validateSession(token);
  requireAdmin_(admin);
  var target = findRowById(SHEETS.USERS, 'UserId', targetUserId);
  if (!target) throw new Error('User not found.');
  return buildDashboardSummary_(target.object);
}

/** Kid: update their own statement delivery preference. */
function setStatementPreference(token, frequency, day) {
  var user = validateSession(token);
  if ([STATEMENT_FREQUENCY.WEEKLY, STATEMENT_FREQUENCY.MONTHLY, STATEMENT_FREQUENCY.NONE].indexOf(frequency) === -1) {
    throw new Error('Invalid statement frequency.');
  }
  updateById(SHEETS.USERS, 'UserId', user.UserId, {
    StatementFrequency: frequency,
    StatementDay: day || ''
  });
  return { ok: true };
}
