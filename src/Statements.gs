/**
 * Periodic HTML email statements, sent on each user's chosen weekly/monthly
 * cadence via a single daily trigger that checks everyone's preference
 * against today's date (simpler than managing per-user triggers, and stays
 * well under Apps Script's per-script trigger count limit).
 */

function isStatementDueToday_(user, today) {
  var day = Number(user.StatementDay);
  if (!day) return false;

  if (user.StatementFrequency === STATEMENT_FREQUENCY.WEEKLY) {
    var isoWeekday = ((today.getDay() + 6) % 7) + 1; // Monday=1 .. Sunday=7
    return day === isoWeekday;
  }
  if (user.StatementFrequency === STATEMENT_FREQUENCY.MONTHLY) {
    var lastDay = lastDayOfMonth(today.getFullYear(), today.getMonth());
    var effectiveDay = Math.min(day, lastDay); // clamp e.g. day=30 in February
    return today.getDate() === effectiveDay;
  }
  return false;
}

function alreadySentForPeriodEnding_(userId, todayStr) {
  return !!findOneWhere(SHEETS.STATEMENT_LOG, function (log) {
    return log.UserId === userId && log.Status === 'SENT' && normalizeDateOnlyString_(log.PeriodEnd) === todayStr;
  });
}

function resolveStatementPeriod_(user, today) {
  var sentLogs = findWhere(SHEETS.STATEMENT_LOG, function (log) { return log.UserId === user.UserId && log.Status === 'SENT'; });
  sentLogs.sort(function (a, b) { return toDateObject_(b.PeriodEnd) - toDateObject_(a.PeriodEnd); });

  var start;
  if (sentLogs.length > 0) {
    start = addDays(toDateObject_(sentLogs[0].PeriodEnd), 1);
  } else {
    start = user.StatementFrequency === STATEMENT_FREQUENCY.WEEKLY ? addDays(today, -7) : addDays(today, -30);
  }
  return { start: start, end: today };
}

/** Daily trigger entry point. */
function runScheduledStatements() {
  var today = nowDate();
  var todayStr = toDateOnlyString(today);

  var users = findWhere(SHEETS.USERS, function (u) {
    return u.Status === USER_STATUS.ACTIVE && u.StatementFrequency && u.StatementFrequency !== STATEMENT_FREQUENCY.NONE;
  });

  users.forEach(function (user) {
    if (!isStatementDueToday_(user, today)) return;
    if (alreadySentForPeriodEnding_(user.UserId, todayStr)) return;

    var period = resolveStatementPeriod_(user, today);
    sendStatementForUser_(user, period.start, period.end);
  });
}

function sendStatementForUser_(user, periodStart, periodEnd) {
  try {
    if (!user.Email) throw new Error('No email address on file.');
    var html = generateStatementHtml(user.UserId, periodStart, periodEnd);
    MailApp.sendEmail({ to: user.Email, subject: 'Your Family Savings statement', htmlBody: html });

    appendRow(SHEETS.STATEMENT_LOG, {
      LogId: newId('log'),
      UserId: user.UserId,
      PeriodStart: toDateOnlyString(periodStart),
      PeriodEnd: toDateOnlyString(periodEnd),
      SentAt: toIsoString(nowDate()),
      Status: 'SENT',
      ErrorMessage: ''
    });
  } catch (err) {
    appendRow(SHEETS.STATEMENT_LOG, {
      LogId: newId('log'),
      UserId: user.UserId,
      PeriodStart: toDateOnlyString(periodStart),
      PeriodEnd: toDateOnlyString(periodEnd),
      SentAt: toIsoString(nowDate()),
      Status: 'FAILED',
      ErrorMessage: err && err.message ? err.message : String(err)
    });
  }
}

/** Renders the HTML statement body for a user over [periodStart, periodEnd]. */
function generateStatementHtml(userId, periodStart, periodEnd) {
  var userRow = findRowById(SHEETS.USERS, 'UserId', userId);
  if (!userRow) throw new Error('User not found: ' + userId);
  var user = userRow.object;

  var savings = getAccountForUser_(userId, ACCOUNT_TYPE.SAVINGS);
  var periodStartStr = toDateOnlyString(periodStart);
  var periodEndStr = toDateOnlyString(periodEnd);

  var periodTxns = findWhere(SHEETS.TRANSACTIONS, function (t) {
    if (t.UserId !== userId || t.Status !== TRANSACTION_STATUS.APPROVED) return false;
    var reviewedDate = normalizeDateOnlyString_(t.ReviewedAt || t.RequestedAt);
    return reviewedDate >= periodStartStr && reviewedDate <= periodEndStr;
  });
  periodTxns.sort(function (a, b) { return toDateObject_(a.RequestedAt) - toDateObject_(b.RequestedAt); });

  var interestEarned = periodTxns
    .filter(function (t) { return t.Type === TRANSACTION_TYPE.INTEREST_POSTED; })
    .reduce(function (sum, t) { return sum + Number(t.Amount); }, 0);

  var realizedGains = periodTxns
    .filter(function (t) { return t.Type === TRANSACTION_TYPE.INVEST_SELL; })
    .reduce(function (sum, t) { return sum + Number(t.RealizedGainLoss || 0); }, 0);

  var holdings = getHoldingsForUser_(userId);
  var holdingsValue = holdings.reduce(function (sum, h) { return sum + h.marketValue; }, 0);

  var template = HtmlService.createTemplateFromFile('StatementTemplate');
  template.displayName = user.DisplayName;
  template.periodStart = periodStartStr;
  template.periodEnd = periodEndStr;
  template.savingsBalance = roundMoney(Number(savings.CashBalance));
  template.interestEarned = roundMoney(interestEarned);
  template.realizedGains = roundMoney(realizedGains);
  template.holdings = holdings;
  template.holdingsValue = roundMoney(holdingsValue);
  template.netWorth = roundMoney(Number(savings.CashBalance) + holdingsValue);
  template.transactions = periodTxns;

  return template.evaluate().getContent();
}
