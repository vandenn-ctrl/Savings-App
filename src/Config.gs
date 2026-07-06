/**
 * Central configuration: sheet names, column layouts, and shared constants.
 * Every other module should reference SHEETS/COLUMNS from here rather than
 * hardcoding sheet or header names.
 */

var SHEETS = {
  USERS: 'Users',
  ACCOUNTS: 'Accounts',
  INTEREST_CONFIG: 'InterestConfig',
  TRANSACTIONS: 'Transactions',
  HOLDINGS: 'Holdings',
  WATCHLIST: 'Watchlist',
  SESSIONS: 'Sessions',
  STATEMENT_LOG: 'StatementLog',
  AUDIT_LOG: 'AuditLog'
};

// Column order also defines the header row written by Bootstrap.gs.
var COLUMNS = {
  // Avatar is appended at the end (rather than interleaved) so it's additive for
  // sheets already created by an earlier version -- Sheets' default grid has plenty
  // of blank columns beyond the header row, so this new column reads as '' safely.
  // Theme is a JSON string ({accent, bgMode, bgFrom, bgTo}) rendered as CSS custom
  // property overrides client-side; '' means "use the app's default look."
  Users: ['UserId', 'Username', 'DisplayName', 'Role', 'PasscodeHash', 'PasscodeSalt',
    'Status', 'StatementFrequency', 'StatementDay', 'Email', 'CreatedAt', 'CreatedBy', 'Avatar', 'Theme'],
  Accounts: ['AccountId', 'UserId', 'AccountType', 'CashBalance', 'InterestRateOverride', 'LastAccrualDate'],
  InterestConfig: ['ConfigId', 'GlobalAnnualRate', 'EffectiveFrom', 'EffectiveTo', 'SetBy', 'SetAt'],
  // PriceSource ('MANUAL' or 'MARKET') is appended at the end -- it's blank for
  // non-investment transaction types and for rows written before this existed.
  Transactions: ['TransactionId', 'UserId', 'AccountId', 'Type', 'Status', 'Amount', 'Ticker',
    'Quantity', 'PriceAtRequest', 'PriceAtApproval', 'RealizedGainLoss', 'RequestedAt',
    'ReviewedBy', 'ReviewedAt', 'ReviewNote', 'Notes', 'PriceSource'],
  Holdings: ['HoldingId', 'UserId', 'AccountId', 'Ticker', 'AssetClass', 'Quantity', 'AvgCostBasis', 'LastUpdated'],
  // LivePrice holds the live =GOOGLEFINANCE(...) formula; LastPrice is the plain value
  // copied from it by refreshPrices(), which is what all application logic reads.
  Watchlist: ['Ticker', 'AssetClass', 'LivePrice', 'LastPrice', 'PriceUpdatedAt', 'Name', 'Currency'],
  Sessions: ['Token', 'UserId', 'CreatedAt', 'ExpiresAt', 'LastSeenAt'],
  StatementLog: ['LogId', 'UserId', 'PeriodStart', 'PeriodEnd', 'SentAt', 'Status', 'ErrorMessage'],
  AuditLog: ['LogId', 'Timestamp', 'ActorUserId', 'Action', 'TargetType', 'TargetId', 'Details']
};

var DEFAULT_AVATAR = '🙂';

var ROLE = { ADMIN: 'ADMIN', KID: 'KID' };
var USER_STATUS = { ACTIVE: 'ACTIVE', DISABLED: 'DISABLED' };
var ACCOUNT_TYPE = { SAVINGS: 'SAVINGS', INVESTMENT: 'INVESTMENT' };
var ASSET_CLASS = { STOCK: 'STOCK', ETF: 'ETF', CRYPTO: 'CRYPTO' };
var STATEMENT_FREQUENCY = { WEEKLY: 'WEEKLY', MONTHLY: 'MONTHLY', NONE: 'NONE' };
var PRICE_SOURCE = { MANUAL: 'MANUAL', MARKET: 'MARKET' };

var TRANSACTION_TYPE = {
  SAVINGS_DEPOSIT: 'SAVINGS_DEPOSIT',
  SAVINGS_WITHDRAWAL: 'SAVINGS_WITHDRAWAL',
  INVEST_BUY: 'INVEST_BUY',
  INVEST_SELL: 'INVEST_SELL',
  INTEREST_POSTED: 'INTEREST_POSTED',
  EMAIL_SENT: 'EMAIL_SENT',
  KID_MESSAGE: 'KID_MESSAGE'
};

var TRANSACTION_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' };

var CONFIG = {
  SESSION_TTL_HOURS: 12,
  CACHE_TTL_SECONDS: 6 * 60 * 60, // CacheService hard cap is 6 hours
  SESSION_TOUCH_THRESHOLD_MINUTES: 30,
  LOCK_WAIT_MS: 10000,
  DAILY_ACCRUAL_DAY_COUNT: 365
};
