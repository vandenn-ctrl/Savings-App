/**
 * Universal transaction request + approval workflow. All transaction types
 * (savings deposit/withdrawal, investment buy/sell) are created PENDING and
 * only take effect once an admin approves them via approveTransaction().
 */

function requestDeposit(token, amount, note) {
  var user = validateSession(token);
  amount = Number(amount);
  if (!amount || amount <= 0) throw new Error('Enter a valid deposit amount.');

  var savings = getAccountForUser_(user.UserId, ACCOUNT_TYPE.SAVINGS);
  return appendRow(SHEETS.TRANSACTIONS, {
    TransactionId: newId('txn'),
    UserId: user.UserId,
    AccountId: savings.AccountId,
    Type: TRANSACTION_TYPE.SAVINGS_DEPOSIT,
    Status: TRANSACTION_STATUS.PENDING,
    Amount: roundMoney(amount),
    Ticker: '', Quantity: '', PriceAtRequest: '', PriceAtApproval: '', RealizedGainLoss: '',
    RequestedAt: toIsoString(nowDate()),
    ReviewedBy: '', ReviewedAt: '', ReviewNote: '',
    Notes: note || ''
  });
}

function requestWithdrawal(token, amount, note) {
  var user = validateSession(token);
  amount = Number(amount);
  if (!amount || amount <= 0) throw new Error('Enter a valid withdrawal amount.');

  var savings = getAccountForUser_(user.UserId, ACCOUNT_TYPE.SAVINGS);
  if (amount > Number(savings.CashBalance)) {
    throw new Error('Withdrawal amount exceeds current savings balance.');
  }

  return appendRow(SHEETS.TRANSACTIONS, {
    TransactionId: newId('txn'),
    UserId: user.UserId,
    AccountId: savings.AccountId,
    Type: TRANSACTION_TYPE.SAVINGS_WITHDRAWAL,
    Status: TRANSACTION_STATUS.PENDING,
    Amount: roundMoney(amount),
    Ticker: '', Quantity: '', PriceAtRequest: '', PriceAtApproval: '', RealizedGainLoss: '',
    RequestedAt: toIsoString(nowDate()),
    ReviewedBy: '', ReviewedAt: '', ReviewNote: '',
    Notes: note || ''
  });
}

function listMyTransactions(token) {
  var user = validateSession(token);
  var rows = findWhere(SHEETS.TRANSACTIONS, function (t) { return t.UserId === user.UserId; });
  rows.sort(function (a, b) { return new Date(b.RequestedAt) - new Date(a.RequestedAt); });
  return rows;
}

/** Admin-only: all pending transactions across every family member, joined with display name. */
function listPendingTransactions(token) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  var pending = findWhere(SHEETS.TRANSACTIONS, function (t) { return t.Status === TRANSACTION_STATUS.PENDING; });
  var users = getAllRows(SHEETS.USERS);
  var nameById = {};
  users.forEach(function (u) { nameById[u.UserId] = u.DisplayName; });

  pending.forEach(function (t) { t.displayName = nameById[t.UserId] || t.UserId; });
  pending.sort(function (a, b) { return new Date(a.RequestedAt) - new Date(b.RequestedAt); });
  return pending;
}

/**
 * Approves a pending transaction and applies its effect to balances/holdings.
 * Wrapped in a script lock, with a fresh re-read of Status inside the lock,
 * to guard against double-approval races (double-click, two open tabs, etc).
 */
function approveTransaction(token, transactionId, note) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    var found = findRowById(SHEETS.TRANSACTIONS, 'TransactionId', transactionId);
    if (!found) throw new Error('Transaction not found.');
    var txn = found.object;
    if (txn.Status !== TRANSACTION_STATUS.PENDING) {
      throw new Error('This transaction was already ' + txn.Status.toLowerCase() + '.');
    }

    var updates = {
      Status: TRANSACTION_STATUS.APPROVED,
      ReviewedBy: admin.UserId,
      ReviewedAt: toIsoString(nowDate()),
      ReviewNote: note || ''
    };

    switch (txn.Type) {
      case TRANSACTION_TYPE.SAVINGS_DEPOSIT:
        applyApprovedDeposit_(txn);
        break;
      case TRANSACTION_TYPE.SAVINGS_WITHDRAWAL:
        applyApprovedWithdrawal_(txn);
        break;
      case TRANSACTION_TYPE.INVEST_BUY:
        updates.PriceAtApproval = applyApprovedBuy_(txn);
        break;
      case TRANSACTION_TYPE.INVEST_SELL:
        var sellResult = applyApprovedSell_(txn);
        updates.PriceAtApproval = sellResult.priceAtApproval;
        updates.RealizedGainLoss = sellResult.realizedGainLoss;
        break;
      default:
        throw new Error('Unknown transaction type: ' + txn.Type);
    }

    updateRowByIndex(SHEETS.TRANSACTIONS, found.rowIndex, updates);
    logAudit_(admin.UserId, 'APPROVE_TRANSACTION', 'Transaction', transactionId, { type: txn.Type });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function rejectTransaction(token, transactionId, reason) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    var found = findRowById(SHEETS.TRANSACTIONS, 'TransactionId', transactionId);
    if (!found) throw new Error('Transaction not found.');
    if (found.object.Status !== TRANSACTION_STATUS.PENDING) {
      throw new Error('This transaction was already ' + found.object.Status.toLowerCase() + '.');
    }

    updateRowByIndex(SHEETS.TRANSACTIONS, found.rowIndex, {
      Status: TRANSACTION_STATUS.REJECTED,
      ReviewedBy: admin.UserId,
      ReviewedAt: toIsoString(nowDate()),
      ReviewNote: reason || ''
    });
    logAudit_(admin.UserId, 'REJECT_TRANSACTION', 'Transaction', transactionId, { reason: reason || '' });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin-only: records a savings deposit/withdrawal directly on a kid's
 * behalf and applies it immediately -- there's no separate approval step
 * since the admin is the one entering it.
 */
function adminRecordSavingsTransaction(token, targetUserId, type, amount, note) {
  var admin = validateSession(token);
  requireAdmin_(admin);
  if (type !== TRANSACTION_TYPE.SAVINGS_DEPOSIT && type !== TRANSACTION_TYPE.SAVINGS_WITHDRAWAL) {
    throw new Error('Invalid transaction type.');
  }
  amount = Number(amount);
  if (!amount || amount <= 0) throw new Error('Enter a valid amount.');

  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    // Validated inside the lock, immediately before writing the (already-APPROVED)
    // row, so we never persist a row whose balance effect then fails to apply.
    var savings = getAccountForUser_(targetUserId, ACCOUNT_TYPE.SAVINGS);
    if (type === TRANSACTION_TYPE.SAVINGS_WITHDRAWAL && amount > Number(savings.CashBalance)) {
      throw new Error('Withdrawal amount exceeds current savings balance.');
    }

    var txn = appendRow(SHEETS.TRANSACTIONS, {
      TransactionId: newId('txn'),
      UserId: targetUserId,
      AccountId: savings.AccountId,
      Type: type,
      Status: TRANSACTION_STATUS.APPROVED,
      Amount: roundMoney(amount),
      Ticker: '', Quantity: '', PriceAtRequest: '', PriceAtApproval: '', RealizedGainLoss: '',
      RequestedAt: toIsoString(nowDate()),
      ReviewedBy: admin.UserId, ReviewedAt: toIsoString(nowDate()), ReviewNote: note || '',
      Notes: 'Entered directly by parent'
    });

    if (type === TRANSACTION_TYPE.SAVINGS_DEPOSIT) {
      applyApprovedDeposit_(txn);
    } else {
      applyApprovedWithdrawal_(txn);
    }

    logAudit_(admin.UserId, 'ADMIN_RECORD_TRANSACTION', 'Transaction', txn.TransactionId, { type: type, targetUserId: targetUserId });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin-only: records an investment buy/sell directly on a kid's behalf and
 * applies it immediately, same rationale as adminRecordSavingsTransaction.
 */
function adminRecordInvestmentTransaction(token, targetUserId, type, ticker, quantity, note) {
  var admin = validateSession(token);
  requireAdmin_(admin);
  if (type !== TRANSACTION_TYPE.INVEST_BUY && type !== TRANSACTION_TYPE.INVEST_SELL) {
    throw new Error('Invalid transaction type.');
  }
  ticker = String(ticker || '').trim().toUpperCase();
  quantity = Number(quantity);
  if (!ticker || !quantity || quantity <= 0) throw new Error('Enter a ticker and quantity.');

  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    ensureTickerTracked_(ticker);
    var quote = getQuote_(ticker);
    var investment = getAccountForUser_(targetUserId, ACCOUNT_TYPE.INVESTMENT);

    // Validated inside the lock, immediately before writing the (already-APPROVED)
    // row, so we never persist a row whose balance/holdings effect then fails to apply.
    if (type === TRANSACTION_TYPE.INVEST_BUY) {
      var savingsForBuy = getAccountForUser_(targetUserId, ACCOUNT_TYPE.SAVINGS);
      var cost = roundMoney(quantity * quote.price);
      if (cost > Number(savingsForBuy.CashBalance)) {
        throw new Error('This purchase (' + formatCurrency(cost) + ') exceeds the kid\'s savings balance.');
      }
    } else {
      var holding = findOneWhere(SHEETS.HOLDINGS, function (h) { return h.UserId === targetUserId && h.Ticker === ticker; });
      if (!holding || Number(holding.Quantity) < quantity) {
        throw new Error('This kid does not hold enough ' + ticker + ' to sell that quantity.');
      }
    }

    var txn = appendRow(SHEETS.TRANSACTIONS, {
      TransactionId: newId('txn'),
      UserId: targetUserId,
      AccountId: investment.AccountId,
      Type: type,
      Status: TRANSACTION_STATUS.APPROVED,
      Amount: roundMoney(quantity * quote.price),
      Ticker: ticker,
      Quantity: quantity,
      PriceAtRequest: quote.price,
      PriceAtApproval: '', RealizedGainLoss: '',
      RequestedAt: toIsoString(nowDate()),
      ReviewedBy: admin.UserId, ReviewedAt: toIsoString(nowDate()), ReviewNote: note || '',
      Notes: 'Entered directly by parent'
    });

    var updates = {};
    if (type === TRANSACTION_TYPE.INVEST_BUY) {
      updates.PriceAtApproval = applyApprovedBuy_(txn);
    } else {
      var sellResult = applyApprovedSell_(txn);
      updates.PriceAtApproval = sellResult.priceAtApproval;
      updates.RealizedGainLoss = sellResult.realizedGainLoss;
    }

    var rowRef = findRowById(SHEETS.TRANSACTIONS, 'TransactionId', txn.TransactionId);
    updateRowByIndex(SHEETS.TRANSACTIONS, rowRef.rowIndex, updates);

    logAudit_(admin.UserId, 'ADMIN_RECORD_TRANSACTION', 'Transaction', txn.TransactionId, { type: type, targetUserId: targetUserId });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function applyApprovedDeposit_(txn) {
  var account = findRowById(SHEETS.ACCOUNTS, 'AccountId', txn.AccountId);
  if (!account) throw new Error('Account not found for deposit.');
  var newBalance = roundMoney(Number(account.object.CashBalance) + Number(txn.Amount));
  updateRowByIndex(SHEETS.ACCOUNTS, account.rowIndex, { CashBalance: newBalance });
}

function applyApprovedWithdrawal_(txn) {
  var account = findRowById(SHEETS.ACCOUNTS, 'AccountId', txn.AccountId);
  if (!account) throw new Error('Account not found for withdrawal.');
  var currentBalance = Number(account.object.CashBalance);
  if (Number(txn.Amount) > currentBalance) {
    throw new Error('Insufficient savings balance to approve this withdrawal (balance may have changed since the request was made).');
  }
  updateRowByIndex(SHEETS.ACCOUNTS, account.rowIndex, { CashBalance: roundMoney(currentBalance - Number(txn.Amount)) });
}
