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
 * manualPrice works the same as in requestBuy/requestSell: give the actual
 * real-world price if known, otherwise the live quote is used.
 */
function adminRecordInvestmentTransaction(token, targetUserId, type, ticker, quantity, note, manualPrice) {
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
    var priceInfo = resolveRequestPrice_(ticker, manualPrice);
    var investment = getAccountForUser_(targetUserId, ACCOUNT_TYPE.INVESTMENT);

    // Validated inside the lock, immediately before writing the (already-APPROVED)
    // row, so we never persist a row whose balance/holdings effect then fails to apply.
    if (type === TRANSACTION_TYPE.INVEST_BUY) {
      var savingsForBuy = getAccountForUser_(targetUserId, ACCOUNT_TYPE.SAVINGS);
      var cost = roundMoney(quantity * priceInfo.price);
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
      Amount: roundMoney(quantity * priceInfo.price),
      Ticker: ticker,
      Quantity: quantity,
      PriceAtRequest: priceInfo.price,
      PriceAtApproval: '', RealizedGainLoss: '',
      RequestedAt: toIsoString(nowDate()),
      ReviewedBy: admin.UserId, ReviewedAt: toIsoString(nowDate()), ReviewNote: note || '',
      Notes: 'Entered directly by parent',
      PriceSource: priceInfo.source
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

// --- Admin edit/delete of any transaction --------------------------------
//
// These operate purely on the values already stored on the transaction row
// (Amount/Quantity/PriceAtApproval) -- never re-fetching a live price -- so
// reversing then re-applying a correction is exact and predictable. One
// known limitation: reversing an INVEST_BUY subtracts quantity from the
// current holding but leaves AvgCostBasis as-is, since the weighted-average
// model doesn't retain individual lot history to recompute it precisely if
// other buys have since blended into the same holding.

function adjustSavingsBalance_(userId, delta) {
  var savings = getAccountForUser_(userId, ACCOUNT_TYPE.SAVINGS);
  var rowRef = findRowById(SHEETS.ACCOUNTS, 'AccountId', savings.AccountId);
  var newBalance = roundMoney(Number(savings.CashBalance) + delta);
  if (newBalance < 0) {
    throw new Error('This change would make the savings balance negative. Adjust or remove other transactions first.');
  }
  updateRowByIndex(SHEETS.ACCOUNTS, rowRef.rowIndex, { CashBalance: newBalance });
}

function adjustHoldingQuantity_(userId, ticker, delta) {
  var holding = findOneWhere(SHEETS.HOLDINGS, function (h) { return h.UserId === userId && h.Ticker === ticker; });
  if (!holding) {
    if (delta <= 0) return; // nothing to reduce; already effectively zero
    throw new Error('No ' + ticker + ' holding found to adjust.');
  }
  var rowRef = findRowById(SHEETS.HOLDINGS, 'HoldingId', holding.HoldingId);
  var newQty = roundQuantity(Number(holding.Quantity) + delta);
  if (newQty < 0) {
    throw new Error('This change would make the ' + ticker + ' holding negative. Adjust or remove other transactions first.');
  }
  updateRowByIndex(SHEETS.HOLDINGS, rowRef.rowIndex, { Quantity: newQty, LastUpdated: toIsoString(nowDate()) });
}

/** Reverses the balance/holdings effect of an already-APPROVED transaction. */
function reverseTransactionEffect_(txn) {
  switch (txn.Type) {
    case TRANSACTION_TYPE.SAVINGS_DEPOSIT:
    case TRANSACTION_TYPE.INTEREST_POSTED:
      adjustSavingsBalance_(txn.UserId, -Number(txn.Amount));
      break;
    case TRANSACTION_TYPE.SAVINGS_WITHDRAWAL:
      adjustSavingsBalance_(txn.UserId, Number(txn.Amount));
      break;
    case TRANSACTION_TYPE.INVEST_BUY:
      adjustSavingsBalance_(txn.UserId, Number(txn.PriceAtApproval) * Number(txn.Quantity));
      adjustHoldingQuantity_(txn.UserId, txn.Ticker, -Number(txn.Quantity));
      break;
    case TRANSACTION_TYPE.INVEST_SELL:
      adjustSavingsBalance_(txn.UserId, -(Number(txn.PriceAtApproval) * Number(txn.Quantity)));
      adjustHoldingQuantity_(txn.UserId, txn.Ticker, Number(txn.Quantity));
      break;
  }
}

/** Re-applies a transaction's effect using its own stored price (used after editing an approved transaction). */
function applyTransactionEffectDirect_(txn) {
  switch (txn.Type) {
    case TRANSACTION_TYPE.SAVINGS_DEPOSIT:
    case TRANSACTION_TYPE.INTEREST_POSTED:
      adjustSavingsBalance_(txn.UserId, Number(txn.Amount));
      break;
    case TRANSACTION_TYPE.SAVINGS_WITHDRAWAL:
      adjustSavingsBalance_(txn.UserId, -Number(txn.Amount));
      break;
    case TRANSACTION_TYPE.INVEST_BUY:
      adjustSavingsBalance_(txn.UserId, -(Number(txn.PriceAtApproval) * Number(txn.Quantity)));
      upsertHoldingOnBuy_(txn.UserId, txn.AccountId, txn.Ticker, Number(txn.Quantity), Number(txn.PriceAtApproval));
      break;
    case TRANSACTION_TYPE.INVEST_SELL:
      adjustSavingsBalance_(txn.UserId, Number(txn.PriceAtApproval) * Number(txn.Quantity));
      adjustHoldingQuantity_(txn.UserId, txn.Ticker, -Number(txn.Quantity));
      break;
  }
}

/** Admin-only: every transaction across every family member, newest first. */
function listAllTransactions(token) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  var all = getAllRows(SHEETS.TRANSACTIONS);
  var users = getAllRows(SHEETS.USERS);
  var nameById = {};
  users.forEach(function (u) { nameById[u.UserId] = u.DisplayName; });

  all.forEach(function (t) { t.displayName = nameById[t.UserId] || t.UserId; });
  all.sort(function (a, b) { return toDateObject_(b.RequestedAt) - toDateObject_(a.RequestedAt); });
  return all;
}

/**
 * Admin-only: permanently removes a transaction. If it was APPROVED, its
 * balance/holdings effect is reversed first so the ledger stays consistent.
 */
function deleteTransaction(token, transactionId) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    var found = findRowById(SHEETS.TRANSACTIONS, 'TransactionId', transactionId);
    if (!found) throw new Error('Transaction not found.');
    var txn = found.object;

    if (txn.Status === TRANSACTION_STATUS.APPROVED) {
      reverseTransactionEffect_(txn);
    }

    getSheet_(SHEETS.TRANSACTIONS).deleteRow(found.rowIndex);
    logAudit_(admin.UserId, 'DELETE_TRANSACTION', 'Transaction', transactionId, { type: txn.Type, status: txn.Status });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Admin-only: edits a transaction's amount (savings/interest types) or
 * quantity (investment types), plus its note. If already APPROVED, its old
 * effect is reversed and the new effect applied atomically, using the same
 * price it was originally approved (or requested) at -- editing corrects
 * "how much", not "at what price".
 */
function editTransaction(token, transactionId, updates) {
  var admin = validateSession(token);
  requireAdmin_(admin);
  updates = updates || {};

  var lock = LockService.getScriptLock();
  lock.waitLock(CONFIG.LOCK_WAIT_MS);
  try {
    var found = findRowById(SHEETS.TRANSACTIONS, 'TransactionId', transactionId);
    if (!found) throw new Error('Transaction not found.');
    var txn = found.object;
    var wasApproved = txn.Status === TRANSACTION_STATUS.APPROVED;
    var isInvest = txn.Type === TRANSACTION_TYPE.INVEST_BUY || txn.Type === TRANSACTION_TYPE.INVEST_SELL;

    if (wasApproved) reverseTransactionEffect_(txn);

    var rowUpdates = {};
    if (updates.notes !== undefined) rowUpdates.Notes = updates.notes;

    var price = Number(txn.PriceAtApproval || txn.PriceAtRequest);
    var updatedTxn = {
      Type: txn.Type,
      UserId: txn.UserId,
      AccountId: txn.AccountId,
      Ticker: txn.Ticker,
      PriceAtApproval: price
    };

    if (isInvest) {
      var newQuantity = (updates.quantity !== undefined && updates.quantity !== '')
        ? roundQuantity(Number(updates.quantity)) : Number(txn.Quantity);
      if (newQuantity <= 0) throw new Error('Enter a valid quantity.');
      rowUpdates.Quantity = newQuantity;
      rowUpdates.Amount = roundMoney(newQuantity * price);
      updatedTxn.Quantity = newQuantity;
    } else {
      var newAmount = (updates.amount !== undefined && updates.amount !== '')
        ? roundMoney(Number(updates.amount)) : Number(txn.Amount);
      var isLogOnly = txn.Type === TRANSACTION_TYPE.EMAIL_SENT || txn.Type === TRANSACTION_TYPE.KID_MESSAGE;
      if (!isLogOnly && newAmount <= 0) throw new Error('Enter a valid amount.');
      rowUpdates.Amount = newAmount;
      updatedTxn.Amount = newAmount;
    }

    if (wasApproved) applyTransactionEffectDirect_(updatedTxn);

    updateRowByIndex(SHEETS.TRANSACTIONS, found.rowIndex, rowUpdates);
    logAudit_(admin.UserId, 'EDIT_TRANSACTION', 'Transaction', transactionId, rowUpdates);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
