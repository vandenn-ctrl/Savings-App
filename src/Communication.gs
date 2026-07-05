/**
 * Ad-hoc email composer for the admin: pick a family member (whose data
 * populates the optional content blocks), a recipient address, which
 * blocks to include, and a free-text message, then send immediately.
 * Unlike Statements.gs (scheduled, per-user-preference statements), this is
 * a one-off email the admin explicitly composes and triggers.
 */

/** Admin-only: sends a composed email. params: { targetUserId, toEmail, subject, includeSavings, includeInvestments, includeHistory, customMessage }. */
function sendCustomEmail(token, params) {
  var admin = validateSession(token);
  requireAdmin_(admin);

  var toEmail = String((params && params.toEmail) || '').trim();
  if (!toEmail) throw new Error('Enter a recipient email address.');

  var subject = (params && params.subject) || 'A message from Family Savings';
  var html = buildCustomEmailHtml_(params || {});

  MailApp.sendEmail({ to: toEmail, subject: subject, htmlBody: html });
  logAudit_(admin.UserId, 'SEND_CUSTOM_EMAIL', 'User', (params && params.targetUserId) || '', { to: toEmail, subject: subject });
  return { ok: true };
}

function buildCustomEmailHtml_(params) {
  var sections = [];

  if (params.customMessage) {
    sections.push('<div style="margin-bottom: 20px; white-space: pre-wrap;">' + escapeHtmlServer_(params.customMessage) + '</div>');
  }

  var user = null;
  if (params.targetUserId) {
    var found = findRowById(SHEETS.USERS, 'UserId', params.targetUserId);
    user = found ? found.object : null;
  }

  if (user && params.includeSavings) {
    var savings = getAccountForUser_(user.UserId, ACCOUNT_TYPE.SAVINGS);
    var rate = getCurrentRate(user.UserId);
    sections.push(
      '<h3 style="color: #2f6f4f;">' + escapeHtmlServer_(user.DisplayName) + '\'s Savings</h3>' +
      '<p>Balance: <strong>$' + Number(savings.CashBalance).toFixed(2) + '</strong><br>' +
      'Current rate: ' + (rate * 100).toFixed(2) + '% APY</p>'
    );
  }

  if (user && params.includeInvestments) {
    var holdings = getHoldingsForUser_(user.UserId);
    if (holdings.length > 0) {
      var rows = holdings.map(function (h) {
        return '<tr><td>' + escapeHtmlServer_(h.ticker) + '</td><td>' + h.quantity + '</td><td>$' +
          h.currentPrice.toFixed(2) + '</td><td>$' + h.marketValue.toFixed(2) + '</td></tr>';
      }).join('');
      sections.push(
        '<h3 style="color: #2f6f4f;">' + escapeHtmlServer_(user.DisplayName) + '\'s Investments</h3>' +
        '<table style="border-collapse: collapse; width: 100%;" cellpadding="6">' +
        '<tr style="color: #52606d; text-align: left;"><th>Ticker</th><th>Qty</th><th>Price</th><th>Value</th></tr>' +
        rows + '</table>'
      );
    } else {
      sections.push('<h3 style="color: #2f6f4f;">' + escapeHtmlServer_(user.DisplayName) + '\'s Investments</h3><p>No holdings yet.</p>');
    }
  }

  if (user && params.includeHistory) {
    var txns = findWhere(SHEETS.TRANSACTIONS, function (t) {
      return t.UserId === user.UserId && t.Status === TRANSACTION_STATUS.APPROVED;
    });
    txns.sort(function (a, b) { return toDateObject_(b.RequestedAt) - toDateObject_(a.RequestedAt); });
    txns = txns.slice(0, 10);

    if (txns.length > 0) {
      var txnRows = txns.map(function (t) {
        var details = t.Ticker ? (t.Ticker + ' x ' + t.Quantity) : ('$' + Number(t.Amount).toFixed(2));
        return '<tr><td>' + escapeHtmlServer_(t.RequestedAt) + '</td><td>' + escapeHtmlServer_(t.Type) + '</td><td>' +
          escapeHtmlServer_(details) + '</td></tr>';
      }).join('');
      sections.push(
        '<h3 style="color: #2f6f4f;">Recent transactions</h3>' +
        '<table style="border-collapse: collapse; width: 100%;" cellpadding="6">' +
        '<tr style="color: #52606d; text-align: left;"><th>Date</th><th>Type</th><th>Details</th></tr>' +
        txnRows + '</table>'
      );
    } else {
      sections.push('<h3 style="color: #2f6f4f;">Recent transactions</h3><p>No approved transactions yet.</p>');
    }
  }

  if (sections.length === 0) {
    sections.push('<p>(No content selected.)</p>');
  }

  return '<div style="font-family: Arial, sans-serif; color: #1f2933; max-width: 600px; margin: 0 auto;">' +
    '<h2 style="color: #2f6f4f;">Family Savings</h2>' +
    sections.join('') +
    '</div>';
}
