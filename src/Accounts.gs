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

/** Cash effect of one approved transaction on a Savings balance; 0 for types that don't touch it (interest/message/email logs excepted, which are handled by their own case). */
function savingsCashDelta_(t) {
  switch (t.Type) {
    case TRANSACTION_TYPE.SAVINGS_DEPOSIT:
    case TRANSACTION_TYPE.INTEREST_POSTED:
      return Number(t.Amount);
    case TRANSACTION_TYPE.SAVINGS_WITHDRAWAL:
      return -Number(t.Amount);
    case TRANSACTION_TYPE.INVEST_BUY:
      return -(Number(t.PriceAtApproval) * Number(t.Quantity));
    case TRANSACTION_TYPE.INVEST_SELL:
      return Number(t.PriceAtApproval) * Number(t.Quantity);
    default:
      return 0;
  }
}

/** Sums cash deltas of every transaction at or before cutoff (sortedTxns must already be sorted ascending by _effectiveDate). */
function balanceAsOf_(sortedTxns, cutoff) {
  var sum = 0;
  for (var i = 0; i < sortedTxns.length; i++) {
    if (sortedTxns[i]._effectiveDate > cutoff) break;
    sum += savingsCashDelta_(sortedTxns[i]);
  }
  return sum;
}

/**
 * Monthly savings-balance history for the past 8 months plus the current
 * (partial) month, reconstructed by replaying every approved cash-affecting
 * transaction from a zero opening balance -- there's no separately-stored
 * balance history, so this is derived fresh each call. Followed by a
 * 4-month forward projection assuming no further deposits, withdrawals,
 * buys or sells -- interest only, compounding daily at the current rate
 * exactly like the real nightly accrual job does, so the projection is what
 * actually happens if nothing else changes.
 */
function buildSavingsHistory_(userId) {
  var rate = getCurrentRate(userId);
  var today = nowDate();

  var cashTxns = findWhere(SHEETS.TRANSACTIONS, function (t) {
    return t.UserId === userId && t.Status === TRANSACTION_STATUS.APPROVED;
  });
  cashTxns.forEach(function (t) { t._effectiveDate = toDateObject_(t.ReviewedAt || t.RequestedAt); });
  cashTxns.sort(function (a, b) { return a._effectiveDate - b._effectiveDate; });

  var points = [];
  for (var i = 8; i >= 0; i--) {
    var monthStart = addMonths_(startOfMonth_(today), -i);
    var cutoff = (i === 0) ? today : addDays(addMonths_(monthStart, 1), -1);
    points.push({ label: monthLabel_(monthStart), value: roundMoney(balanceAsOf_(cashTxns, cutoff)), projected: false });
  }

  var baselineBalance = points[points.length - 1].value;
  for (var p = 1; p <= 4; p++) {
    var targetDate = addMonths_(today, p);
    var days = daysBetween(today, targetDate);
    var projectedBalance = baselineBalance * Math.pow(1 + rate / CONFIG.DAILY_ACCRUAL_DAY_COUNT, days);
    points.push({ label: monthLabel_(targetDate), value: roundMoney(projectedBalance), projected: true });
  }

  return { points: points, currentBalance: baselineBalance, rate: rate };
}

/** Kid (or admin viewing their own account): savings history + projection. */
function getSavingsHistory(token) {
  var user = validateSession(token);
  return buildSavingsHistory_(user.UserId);
}

/** Admin-only: any kid's savings history + projection. */
function getUserSavingsHistory(token, targetUserId) {
  var admin = validateSession(token);
  requireAdmin_(admin);
  var target = findRowById(SHEETS.USERS, 'UserId', targetUserId);
  if (!target) throw new Error('User not found.');
  return buildSavingsHistory_(targetUserId);
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
