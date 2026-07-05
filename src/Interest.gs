/**
 * Savings interest: rate resolution (global default + per-kid override),
 * daily accrual posting, and a live "accrued so far today" calculation for
 * the dashboard that doesn't require waiting on the nightly batch.
 *
 * Rates are annual; daily accrual divides by 365 (a simple convention
 * chosen over exact day-count conventions real banks use, since this is a
 * family app, not a regulated financial product).
 */

function getCurrentGlobalRateRow_() {
  var today = normalizeDateOnlyString_(nowDate());
  var candidates = findWhere(SHEETS.INTEREST_CONFIG, function (row) {
    var from = normalizeDateOnlyString_(row.EffectiveFrom);
    var to = normalizeDateOnlyString_(row.EffectiveTo);
    return from <= today && (!to || to > today);
  });
  if (candidates.length === 0) throw new Error('No active global interest rate is configured.');
  candidates.sort(function (a, b) {
    return normalizeDateOnlyString_(b.EffectiveFrom) < normalizeDateOnlyString_(a.EffectiveFrom) ? -1 : 1;
  });
  return candidates[0];
}

/** Resolves the annual rate that applies to a given kid: per-kid override if set, else the current global rate. */
function getCurrentRate(userId) {
  var savings = getAccountForUser_(userId, ACCOUNT_TYPE.SAVINGS);
  if (savings.InterestRateOverride !== '' && savings.InterestRateOverride !== null && savings.InterestRateOverride !== undefined) {
    return Number(savings.InterestRateOverride);
  }
  return Number(getCurrentGlobalRateRow_().GlobalAnnualRate);
}

function getGlobalRateInfo(token) {
  validateSession(token);
  var row = getCurrentGlobalRateRow_();
  return { rate: Number(row.GlobalAnnualRate), effectiveFrom: normalizeDateOnlyString_(row.EffectiveFrom) };
}

/**
 * Admin-only: changes the global rate effective from a given date, preserving
 * history. newRatePercent is in percentage terms (enter 3 for 3%, 2.5 for
 * 2.5%) -- converted to the decimal fraction the rest of the app stores and
 * calculates with.
 */
function setGlobalRate(token, newRatePercent, effectiveFromStr) {
  var admin = validateSession(token);
  requireAdmin_(admin);
  newRatePercent = Number(newRatePercent);
  if (isNaN(newRatePercent) || newRatePercent < 0) throw new Error('Enter a valid annual rate.');
  if (!effectiveFromStr) throw new Error('Enter an effective date.');
  var newRate = newRatePercent / 100;

  var current = getCurrentGlobalRateRow_();
  var currentRow = findRowById(SHEETS.INTEREST_CONFIG, 'ConfigId', current.ConfigId);
  var dayBefore = toDateOnlyString(addDays(new Date(effectiveFromStr), -1));
  updateRowByIndex(SHEETS.INTEREST_CONFIG, currentRow.rowIndex, { EffectiveTo: dayBefore });

  appendRow(SHEETS.INTEREST_CONFIG, {
    ConfigId: newId('cfg'),
    GlobalAnnualRate: newRate,
    EffectiveFrom: effectiveFromStr,
    EffectiveTo: '',
    SetBy: admin.UserId,
    SetAt: toIsoString(nowDate())
  });

  logAudit_(admin.UserId, 'SET_GLOBAL_RATE', 'InterestConfig', '', { rate: newRate, effectiveFrom: effectiveFromStr });
  return { ok: true };
}

/**
 * Admin-only: set (or clear, if ratePercent is null/blank) a per-kid rate
 * override. Same percentage-terms convention as setGlobalRate.
 */
function setUserRateOverride(token, targetUserId, ratePercent) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  var savings = findOneWhere(SHEETS.ACCOUNTS, function (a) {
    return a.UserId === targetUserId && a.AccountType === ACCOUNT_TYPE.SAVINGS;
  });
  if (!savings) throw new Error('Savings account not found for user.');
  var rowRef = findRowById(SHEETS.ACCOUNTS, 'AccountId', savings.AccountId);

  var isBlank = ratePercent === null || ratePercent === '' || ratePercent === undefined || isNaN(Number(ratePercent));
  var value = isBlank ? '' : Number(ratePercent) / 100;
  updateRowByIndex(SHEETS.ACCOUNTS, rowRef.rowIndex, { InterestRateOverride: value });

  logAudit_(admin.UserId, 'SET_RATE_OVERRIDE', 'User', targetUserId, { rate: value });
  return { ok: true };
}

/** Pure calculation: interest accrued on a savings account since its LastAccrualDate, as of asOfDate. Does not mutate anything. */
function computeAccruedInterest(accountId, asOfDate) {
  var account = findOneWhere(SHEETS.ACCOUNTS, function (a) { return a.AccountId === accountId; });
  if (!account) throw new Error('Account not found: ' + accountId);

  var rate = getCurrentRate(account.UserId);
  var lastAccrual = toDateObject_(account.LastAccrualDate);
  var days = daysBetween(lastAccrual, asOfDate);
  if (days <= 0) return 0;

  return roundMoney(Number(account.CashBalance) * (rate / CONFIG.DAILY_ACCRUAL_DAY_COUNT) * days);
}

/**
 * Daily batch: posts one day's interest into every kid's savings balance as
 * an auto-approved INTEREST_POSTED transaction, so it's fully visible in
 * transaction history and statements. Run from a time-driven trigger.
 */
function accrueInterestForAllSavings() {
  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    var today = nowDate();
    var savingsAccounts = findWhere(SHEETS.ACCOUNTS, function (a) { return a.AccountType === ACCOUNT_TYPE.SAVINGS; });

    savingsAccounts.forEach(function (account) {
      var interest = computeAccruedInterest(account.AccountId, today);
      var rowRef = findRowById(SHEETS.ACCOUNTS, 'AccountId', account.AccountId);

      if (interest > 0) {
        var newBalance = roundMoney(Number(account.CashBalance) + interest);
        updateRowByIndex(SHEETS.ACCOUNTS, rowRef.rowIndex, {
          CashBalance: newBalance,
          LastAccrualDate: toDateOnlyString(today)
        });

        appendRow(SHEETS.TRANSACTIONS, {
          TransactionId: newId('txn'),
          UserId: account.UserId,
          AccountId: account.AccountId,
          Type: TRANSACTION_TYPE.INTEREST_POSTED,
          Status: TRANSACTION_STATUS.APPROVED,
          Amount: interest,
          Ticker: '', Quantity: '', PriceAtRequest: '', PriceAtApproval: '', RealizedGainLoss: '',
          RequestedAt: toIsoString(today),
          ReviewedBy: 'system', ReviewedAt: toIsoString(today), ReviewNote: '',
          Notes: 'Daily interest accrual'
        });
      } else {
        // Still advance LastAccrualDate so a $0-balance account doesn't recompute the same zero-day range forever.
        updateRowByIndex(SHEETS.ACCOUNTS, rowRef.rowIndex, { LastAccrualDate: toDateOnlyString(today) });
      }
    });
  } finally {
    lock.releaseLock();
  }
}
