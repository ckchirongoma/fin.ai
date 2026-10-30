// Fin — how a plan page is printed. Shared by the renderer (pdf.ts) and the
// print checks in scripts/, so a check prints exactly what production prints.
// No Chromium import here on purpose: see pdf.ts for why that stays isolated.

/** Business name and page number at the foot of every page. Chromium fills the classed spans. */
export const FOOTER_TEMPLATE =
  '<div style="width:100%;font-family:Helvetica,Arial,\'Open Sans\',sans-serif;font-size:7.5px;color:#6b756e;padding:0 40px;box-sizing:border-box">' +
  '<span class="title"></span><span style="float:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';

export const PDF_OPTIONS = {
  format: "A4" as const,
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: "0", bottom: "0", left: "0", right: "0" },
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate: FOOTER_TEMPLATE,
};
