/**
 * Web app entry point.
 */

function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Family Savings')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used by templated HTML files to inline shared partials: <?!= include('Shared_CSS') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
