# Family Savings App

A private family savings & investment tracker. Kids get a Savings account
that earns interest set by a parent/admin, and an Investment "account" for
buying real stocks/ETFs/crypto priced off Google Sheets' `GOOGLEFINANCE()`.
Every transaction a kid submits (deposit, withdrawal, buy, sell) sits as a
pending request until the parent approves it. Built entirely on **Google
Sheets** (data store), **Google Apps Script** (backend), and an Apps Script
**HtmlService web app** (frontend) — no external hosting or database needed.

## One-time setup

You'll need [clasp](https://github.com/google/clasp), Google's CLI for
managing Apps Script projects from the command line.

1. Install dependencies:
   ```
   npm install
   ```

2. Log in to your Google account via clasp (opens a browser):
   ```
   npm run login
   ```

3. Create a new Google Sheet (this will be your database) and a bound Apps
   Script project in one step:
   ```
   npm run create
   ```
   This generates a real `.clasp.json` (already gitignored — it contains
   your personal script ID, not something to commit). If you'd rather bind
   to a Sheet you already created, open that Sheet's
   **Extensions → Apps Script**, copy its Script ID from
   **Project Settings**, and paste it into a `.clasp.json` you create from
   `.clasp.json.example`.

4. Push the code in `src/` to the Apps Script project:
   ```
   npm run push
   ```

5. Open the Apps Script editor:
   ```
   npm run open
   ```
   In the editor:
   - Select `initializeSpreadsheet` from the function dropdown and click
     **Run**. This creates every sheet tab (Users, Accounts, Transactions,
     Holdings, Watchlist, Sessions, etc.) with headers, and seeds a default
     3% global interest rate. Grant the permissions it asks for.
   - Open `Bootstrap.gs`, edit the `username`/`passcode`/`email` values
     inside `createInitialAdmin()` to your own, then select and run
     `createInitialAdmin`. This is the only account created outside the
     app itself (every other account is created from the Admin dashboard).
   - Select and run `installTriggers`. This sets up the four background
     jobs (interest accrual, hourly price refresh, statement scheduling,
     session cleanup). Safe to re-run any time — it replaces rather than
     duplicates triggers.

6. Deploy the web app:
   - In the Apps Script editor: **Deploy → New deployment → Web app**.
   - **Execute as: Me**. The app must run under your identity regardless of
     which family member is using it — the app's own username/access-code
     login (not Google sign-in) is the real security gate.
   - **Who has access: Anyone**. Kids don't have Google accounts to
     restrict access to, so the deployed URL itself is unauthenticated at
     the Google layer; the login screen is what actually gates data access.
   - Copy the resulting web app URL — that's the app's address for the
     whole family. Bookmark it.

7. Log in at that URL with the admin username/passcode from step 5, and use
   the **Users** tab to create an account for each kid.

Whenever you change code in `src/`, run `npm run push`, then in
**Deploy → Manage deployments**, edit the existing deployment and choose a
new version — the live URL only picks up changes after that.

## Project layout

- `Config.gs` — sheet/column name constants shared by every module.
- `Repository.gs` — generic data-access layer over `SpreadsheetApp`.
- `Utils.gs` — ID generation, date/currency formatting, audit logging.
- `Bootstrap.gs` — one-time sheet creation and first-admin setup (run manually).
- `Auth.gs` / `SessionStore.gs` — username + access-code login and session tokens.
- `Accounts.gs` — user/account management and dashboard summary reads.
- `Transactions.gs` — deposit/withdrawal requests and the approve/reject workflow.
- `Investments.gs` — buy/sell requests and the `GOOGLEFINANCE()` price bridge.
- `Interest.gs` — rate management and daily interest accrual.
- `Statements.gs` — HTML email statement generation and scheduling.
- `Triggers.gs` — installs the four time-driven triggers.
- `Code.gs` — web app entry point (`doGet`).
- `Index.html`, `Login.html`, `KidDashboard.html`, `AdminDashboard.html`,
  `Shared_CSS.html`, `Shared_JS.html`, `StatementTemplate.html` — frontend.

## Notes and limitations

- **Passcode hashing** uses salted SHA-256 (`Utilities.computeDigest`), not
  bcrypt/PBKDF2 — Apps Script has no slow KDF available. Acceptable for a
  private family app whose underlying Sheet is already access-controlled
  via Drive sharing, not a bank-grade threat model.
- **GOOGLEFINANCE() pricing** is delayed (typically ~15-20 min for
  equities) and can return `#N/A` transiently; crypto ticker coverage is
  narrower than equities. The app always shows a "price as of" timestamp
  and never lets a transient error corrupt a stored valuation.
- **Ticker convention**: plain symbols (`AAPL`, `VTI`) are treated as
  stocks/ETFs; a symbol written as `SYMBOL-XXX` (e.g. `BTC-USD`) is treated
  as crypto.
- **Apps Script quotas**: consumer accounts share a daily trigger-runtime
  budget across all triggers and have a daily `MailApp` send cap — both are
  irrelevant at family scale but worth knowing if you ever scale this up.

## Verification

Since this app only runs inside Google's Apps Script/Sheets environment,
it can't be exercised locally — after deploying (steps above), verify by:

1. Logging in as admin, creating a kid account, then logging in as that kid
   and submitting a deposit and a buy request.
2. Logging back in as admin, approving both from the **Approvals** tab, and
   confirming the Sheet's `Accounts`, `Holdings`, and `Transactions` tabs
   updated correctly.
3. Manually running `accrueInterestForAllSavings`, `refreshPrices`, and
   `runScheduledStatements` from the Apps Script editor and checking the
   Sheet rows / a test inbox.
4. Attempting to approve the same pending transaction twice in quick
   succession and confirming the second attempt is rejected with an
   "already processed" error rather than double-applying the balance change.
