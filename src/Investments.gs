/**
 * Investment buy/sell workflow and the Watchlist/GOOGLEFINANCE price bridge.
 *
 * Apps Script cannot call GOOGLEFINANCE() directly — it only evaluates
 * inside a Sheets cell formula. So each tracked ticker gets a row in the
 * Watchlist sheet with a live `=GOOGLEFINANCE(...)` formula in LivePrice;
 * refreshPrices() reads that cell's *computed* value and copies it into the
 * plain LastPrice column (skipping the copy if the formula is currently
 * erroring, e.g. a transient #N/A), which is what the rest of the app reads.
 *
 * Ticker convention: plain symbols ("AAPL", "VTI") are treated as stocks/
 * ETFs; a symbol written as "BTC-USD" style (SYMBOL-XXX, 3-letter fiat
 * suffix) is treated as crypto and mapped to GOOGLEFINANCE's CURRENCY: form.
 */

function inferAssetClass_(ticker) {
  return /^[A-Z0-9]{2,10}-[A-Z]{3}$/.test(ticker) ? ASSET_CLASS.CRYPTO : ASSET_CLASS.STOCK;
}

function buildFinanceFormula_(ticker, assetClass) {
  if (assetClass === ASSET_CLASS.CRYPTO) {
    var pair = ticker.replace('-', '');
    return '=GOOGLEFINANCE("CURRENCY:' + pair + '")';
  }
  return '=GOOGLEFINANCE("' + ticker + '","price")';
}

function ensureTickerTracked_(ticker) {
  var existing = findOneWhere(SHEETS.WATCHLIST, function (row) { return row.Ticker === ticker; });
  if (existing) return existing;

  var assetClass = inferAssetClass_(ticker);
  appendRow(SHEETS.WATCHLIST, {
    Ticker: ticker,
    AssetClass: assetClass,
    LivePrice: buildFinanceFormula_(ticker, assetClass),
    LastPrice: '',
    PriceUpdatedAt: '',
    Name: assetClass === ASSET_CLASS.STOCK ? '=GOOGLEFINANCE("' + ticker + '","name")' : '',
    Currency: ''
  });

  refreshSingleTickerPrice_(ticker);
  return findOneWhere(SHEETS.WATCHLIST, function (row) { return row.Ticker === ticker; });
}

/** Reads the last refreshed plain-value price for a ticker. Throws if none is available yet. */
function getQuote_(ticker) {
  var row = findOneWhere(SHEETS.WATCHLIST, function (r) { return r.Ticker === ticker; });
  if (!row || row.LastPrice === '' || row.LastPrice === undefined || row.LastPrice === null) {
    throw new Error('No price available yet for ' + ticker + '. Please try again in a moment.');
  }
  return { price: Number(row.LastPrice), asOf: row.PriceUpdatedAt };
}

/** Public trigger entry point: refresh every tracked ticker's LastPrice from its live formula. */
function refreshPrices() {
  refreshPricesInternal_(null);
}

function refreshSingleTickerPrice_(ticker) {
  refreshPricesInternal_(ticker);
}

function refreshPricesInternal_(onlyTicker) {
  var sheet = getSheet_(SHEETS.WATCHLIST);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  SpreadsheetApp.flush(); // force GOOGLEFINANCE formulas to recalculate before we read them

  var idx = getHeaderIndex_(SHEETS.WATCHLIST);
  var numCols = COLUMNS.Watchlist.length;
  var values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  var lastPriceCol = idx.LastPrice + 1;
  var updatedAtCol = idx.PriceUpdatedAt + 1;
  var lastPriceValues = sheet.getRange(2, lastPriceCol, values.length, 1).getValues();
  var updatedAtValues = sheet.getRange(2, updatedAtCol, values.length, 1).getValues();

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (onlyTicker && row[idx.Ticker] !== onlyTicker) continue;
    var livePrice = row[idx.LivePrice];
    if (typeof livePrice === 'number' && isFinite(livePrice)) {
      lastPriceValues[i][0] = roundMoney(livePrice);
      updatedAtValues[i][0] = toIsoString(nowDate());
    }
    // else: GOOGLEFINANCE is currently erroring (#N/A etc) — leave the last-known-good value in place.
  }

  sheet.getRange(2, lastPriceCol, lastPriceValues.length, 1).setValues(lastPriceValues);
  sheet.getRange(2, updatedAtCol, updatedAtValues.length, 1).setValues(updatedAtValues);
}

function requestBuy(token, ticker, quantity) {
  var user = validateSession(token);
  ticker = String(ticker || '').trim().toUpperCase();
  quantity = Number(quantity);
  if (!ticker || !quantity || quantity <= 0) throw new Error('Enter a ticker and quantity.');

  ensureTickerTracked_(ticker);
  var quote = getQuote_(ticker);
  var amount = roundMoney(quantity * quote.price);

  var savings = getAccountForUser_(user.UserId, ACCOUNT_TYPE.SAVINGS);
  if (amount > Number(savings.CashBalance)) {
    throw new Error('This purchase (' + formatCurrency(amount) + ') exceeds your savings balance.');
  }

  var investment = getAccountForUser_(user.UserId, ACCOUNT_TYPE.INVESTMENT);
  return appendRow(SHEETS.TRANSACTIONS, {
    TransactionId: newId('txn'),
    UserId: user.UserId,
    AccountId: investment.AccountId,
    Type: TRANSACTION_TYPE.INVEST_BUY,
    Status: TRANSACTION_STATUS.PENDING,
    Amount: amount,
    Ticker: ticker,
    Quantity: quantity,
    PriceAtRequest: quote.price,
    PriceAtApproval: '', RealizedGainLoss: '',
    RequestedAt: toIsoString(nowDate()),
    ReviewedBy: '', ReviewedAt: '', RejectionReason: '',
    Notes: ''
  });
}

function requestSell(token, ticker, quantity) {
  var user = validateSession(token);
  ticker = String(ticker || '').trim().toUpperCase();
  quantity = Number(quantity);
  if (!ticker || !quantity || quantity <= 0) throw new Error('Enter a ticker and quantity.');

  var holding = findOneWhere(SHEETS.HOLDINGS, function (h) { return h.UserId === user.UserId && h.Ticker === ticker; });
  if (!holding || Number(holding.Quantity) < quantity) {
    throw new Error('You do not hold enough ' + ticker + ' to sell that quantity.');
  }

  var quote = getQuote_(ticker);
  var amount = roundMoney(quantity * quote.price);
  var investment = getAccountForUser_(user.UserId, ACCOUNT_TYPE.INVESTMENT);

  return appendRow(SHEETS.TRANSACTIONS, {
    TransactionId: newId('txn'),
    UserId: user.UserId,
    AccountId: investment.AccountId,
    Type: TRANSACTION_TYPE.INVEST_SELL,
    Status: TRANSACTION_STATUS.PENDING,
    Amount: amount,
    Ticker: ticker,
    Quantity: quantity,
    PriceAtRequest: quote.price,
    PriceAtApproval: '', RealizedGainLoss: '',
    RequestedAt: toIsoString(nowDate()),
    ReviewedBy: '', ReviewedAt: '', RejectionReason: '',
    Notes: ''
  });
}

/** Called by Transactions.approveTransaction for INVEST_BUY. Returns the price actually applied. */
function applyApprovedBuy_(txn) {
  refreshSingleTickerPrice_(txn.Ticker);
  var priceAtApproval = getQuote_(txn.Ticker).price;
  var cost = roundMoney(Number(txn.Quantity) * priceAtApproval);

  var savingsAccount = getAccountForUser_(txn.UserId, ACCOUNT_TYPE.SAVINGS);
  if (cost > Number(savingsAccount.CashBalance)) {
    throw new Error('Insufficient savings balance to approve this buy (balance may have changed since the request was made).');
  }

  var savingsRow = findRowById(SHEETS.ACCOUNTS, 'AccountId', savingsAccount.AccountId);
  updateRowByIndex(SHEETS.ACCOUNTS, savingsRow.rowIndex, {
    CashBalance: roundMoney(Number(savingsAccount.CashBalance) - cost)
  });

  upsertHoldingOnBuy_(txn.UserId, txn.AccountId, txn.Ticker, Number(txn.Quantity), priceAtApproval);
  return priceAtApproval;
}

/** Called by Transactions.approveTransaction for INVEST_SELL. Returns { priceAtApproval, realizedGainLoss }. */
function applyApprovedSell_(txn) {
  var holding = findOneWhere(SHEETS.HOLDINGS, function (h) { return h.UserId === txn.UserId && h.Ticker === txn.Ticker; });
  if (!holding || Number(holding.Quantity) < Number(txn.Quantity)) {
    throw new Error('Holdings changed since this request was made; insufficient ' + txn.Ticker + ' to approve this sell.');
  }

  refreshSingleTickerPrice_(txn.Ticker);
  var priceAtApproval = getQuote_(txn.Ticker).price;
  var proceeds = roundMoney(Number(txn.Quantity) * priceAtApproval);
  var realizedGainLoss = roundMoney(Number(txn.Quantity) * (priceAtApproval - Number(holding.AvgCostBasis)));

  var holdingRow = findRowById(SHEETS.HOLDINGS, 'HoldingId', holding.HoldingId);
  updateRowByIndex(SHEETS.HOLDINGS, holdingRow.rowIndex, {
    Quantity: roundMoney(Number(holding.Quantity) - Number(txn.Quantity)),
    LastUpdated: toIsoString(nowDate())
  });

  var savingsAccount = getAccountForUser_(txn.UserId, ACCOUNT_TYPE.SAVINGS);
  var savingsRow = findRowById(SHEETS.ACCOUNTS, 'AccountId', savingsAccount.AccountId);
  updateRowByIndex(SHEETS.ACCOUNTS, savingsRow.rowIndex, {
    CashBalance: roundMoney(Number(savingsAccount.CashBalance) + proceeds)
  });

  return { priceAtApproval: priceAtApproval, realizedGainLoss: realizedGainLoss };
}

function upsertHoldingOnBuy_(userId, accountId, ticker, qty, price) {
  var existing = findOneWhere(SHEETS.HOLDINGS, function (h) { return h.UserId === userId && h.Ticker === ticker; });
  if (existing) {
    var oldQty = Number(existing.Quantity);
    var newQty = oldQty + qty;
    var newAvgCost = ((oldQty * Number(existing.AvgCostBasis)) + (qty * price)) / newQty;
    var rowRef = findRowById(SHEETS.HOLDINGS, 'HoldingId', existing.HoldingId);
    updateRowByIndex(SHEETS.HOLDINGS, rowRef.rowIndex, {
      Quantity: newQty,
      AvgCostBasis: roundMoney(newAvgCost),
      LastUpdated: toIsoString(nowDate())
    });
  } else {
    appendRow(SHEETS.HOLDINGS, {
      HoldingId: newId('hld'),
      UserId: userId,
      AccountId: accountId,
      Ticker: ticker,
      AssetClass: inferAssetClass_(ticker),
      Quantity: qty,
      AvgCostBasis: roundMoney(price),
      LastUpdated: toIsoString(nowDate())
    });
  }
}

/** Internal: live-valued holdings list for a user, used by dashboard summaries and statements. */
function getHoldingsForUser_(userId) {
  var holdings = findWhere(SHEETS.HOLDINGS, function (h) { return h.UserId === userId && Number(h.Quantity) > 0; });
  var priceByTicker = {};
  getAllRows(SHEETS.WATCHLIST).forEach(function (w) {
    priceByTicker[w.Ticker] = { price: Number(w.LastPrice) || 0, asOf: w.PriceUpdatedAt };
  });

  return holdings.map(function (h) {
    var quote = priceByTicker[h.Ticker] || { price: 0, asOf: '' };
    var quantity = Number(h.Quantity);
    var avgCostBasis = Number(h.AvgCostBasis);
    return {
      ticker: h.Ticker,
      quantity: quantity,
      avgCostBasis: avgCostBasis,
      currentPrice: quote.price,
      marketValue: roundMoney(quantity * quote.price),
      unrealizedGainLoss: roundMoney(quantity * (quote.price - avgCostBasis)),
      priceAsOf: quote.asOf
    };
  });
}
