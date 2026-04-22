(async () => {
  const src = browser.runtime.getURL("js/asciidocify.js");
  const contentMain = await import(src);
  contentMain.init();
})();
