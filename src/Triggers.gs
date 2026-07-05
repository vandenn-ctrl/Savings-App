/**
 * Time-driven trigger setup. Run installTriggers() once manually from the
 * Apps Script editor after deploying (it's idempotent — re-running it will
 * not create duplicates). This wires up the app's four background jobs:
 * interest accrual, price refresh, statement scheduling, and session cleanup.
 */

function installTriggers() {
  removeTriggersFor_('accrueInterestForAllSavings');
  ScriptApp.newTrigger('accrueInterestForAllSavings').timeBased().everyDays(1).atHour(2).create();

  removeTriggersFor_('refreshPrices');
  ScriptApp.newTrigger('refreshPrices').timeBased().everyHours(1).create();

  removeTriggersFor_('runScheduledStatements');
  ScriptApp.newTrigger('runScheduledStatements').timeBased().everyDays(1).atHour(6).create();

  removeTriggersFor_('purgeExpiredSessions');
  ScriptApp.newTrigger('purgeExpiredSessions').timeBased().everyDays(1).atHour(3).create();

  Logger.log('Triggers installed: accrueInterestForAllSavings (daily 2am), ' +
    'refreshPrices (hourly), runScheduledStatements (daily 6am), purgeExpiredSessions (daily 3am).');
}

function removeTriggersFor_(handlerFunctionName) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handlerFunctionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
