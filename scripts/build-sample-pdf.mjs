#!/usr/bin/env node
/**
 * Build the built-in 2-page sample PDF (`src-tauri/resources/sample.pdf`),
 * embedded into the app so a new reader can try search, marks, citations,
 * tables and internal links in ten seconds without hunting for a file or
 * configuring an API key first.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "src-tauri", "resources", "sample.pdf");
mkdirSync(dirname(OUT), { recursive: true });

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>PageWise Sample — Equipment &amp; Service Brief</title>
<style>
  @page { size: A4; margin: 18mm 18mm 20mm 18mm; }
  body {
    font-family: "DejaVu Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 10pt;
    line-height: 1.54;
    color: #18181b;
  }
  h1 { font-size: 16pt; margin: 0 0 4pt 0; letter-spacing: -0.01em; }
  .lead { font-size: 9.2pt; color: #52525b; margin: 0 0 14pt 0; }
  h2 { font-size: 12pt; margin: 14pt 0 6pt 0; border-bottom: 0.75pt solid #e4e4e7; padding-bottom: 3pt; }
  p { margin: 0 0 8pt 0; text-align: justify; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt 0; font-size: 9.2pt; }
  th, td { border: 0.75pt solid #d4d4d8; padding: 5pt 7pt; text-align: left; }
  th { background: #f4f4f5; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: #1d4ed8; text-decoration: underline; }
  .page-break { page-break-before: always; }
</style>
</head>
<body>
  <h1>PageWise Sample Brief — Equipment &amp; Service Agreement</h1>
  <p class="lead">A two-page reference document for trying search (Cmd/Ctrl+F), text highlights, margin notes, region selection, and verified citations. Jump to <a href="#terms">Section 3 (Payment, Warranty &amp; Uptime Terms)</a> on page 2 for response-time guarantees.</p>

  <h2>1. Overview &amp; Scope</h2>
  <p>Under Agreement No. PW-2026-09, Northwind Medical Systems ("Supplier") delivers two digital radiography units and one diagnostic workstation to Riverside Clinic ("Buyer") within 45 calendar days of contract execution. Reading, instant full-text search, margin highlights, and local OCR run entirely on this computer without an API key; when an AI provider is connected, every factual answer cites the exact page and verbatim wording it rests on.</p>
  <p>All equipment supplied under this brief conforms to IEC 60601-1 safety standards and includes factory calibration certificates, installation, and operator acceptance testing at Buyer's main imaging suite.</p>

  <h2>2. Schedule of Deliverables &amp; Pricing</h2>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Model / Specification</th>
        <th class="num">Qty</th>
        <th class="num">Unit Price</th>
        <th class="num">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Digital Radiography System</td>
        <td>NW-DR 800 Dual-Detector</td>
        <td class="num">2</td>
        <td class="num">$140,000</td>
        <td class="num">$280,000</td>
      </tr>
      <tr>
        <td>Diagnostic Workstation</td>
        <td>NW-View Pro 32-inch 6MP</td>
        <td class="num">1</td>
        <td class="num">$35,000</td>
        <td class="num">$35,000</td>
      </tr>
      <tr>
        <td>On-Site Clinical Training</td>
        <td>16 hours (4 sessions)</td>
        <td class="num">1</td>
        <td class="num">$5,000</td>
        <td class="num">$5,000</td>
      </tr>
      <tr>
        <td><strong>Total Contract Value</strong></td>
        <td><strong>Delivered &amp; Installed</strong></td>
        <td class="num"><strong>—</strong></td>
        <td class="num"><strong>—</strong></td>
        <td class="num"><strong>$320,000</strong></td>
      </tr>
    </tbody>
  </table>

  <div class="page-break"></div>

  <h2 id="terms">3. Payment, Warranty &amp; Uptime Terms</h2>
  <p><strong>Payment milestones.</strong> Buyer shall pay 30% ($96,000) within 10 business days of signing, 60% ($192,000) within 15 business days of signed acceptance, and the remaining 10% ($32,000) quality retention upon completion of 12 months of defect-free operation.</p>
  <p><strong>Warranty &amp; uptime guarantee.</strong> The complete system carries a 36-month warranty from final acceptance, while flat-panel detector modules are covered for 60 months. Supplier guarantees annual operational uptime of at least 98.5%; for each 0.5 percentage point below 98.5%, the warranty period extends by 1 additional month. Following any fault report, Supplier provides remote diagnostics within 2 hours and on-site engineering support within 24 hours.</p>

  <h2>4. Late Delivery, Efficiency Benchmarks &amp; Liability Cap</h2>
  <p>If delivery is delayed for reasons attributable to Supplier, liquidated damages accrue at 0.05% of the total contract value per calendar day, capped at 5% ($16,000). If delay exceeds 30 calendar days, Buyer may terminate this Agreement upon written notice. Aggregate liability of either party under this Agreement shall not exceed 100% of the total contract value ($320,000), except for breaches of confidentiality or patient data protection.</p>
  <p><strong>Measured operating benchmarks.</strong> Compared with the prior NW-DR 700 generation, the NW-DR 800 reduces standby power draw by −18.4%, lowers per-exposure radiation dose by −12.5%, and completes full-resolution image reconstruction in 1.8 seconds.</p>
</body>
</html>`;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
await page.setContent(HTML, { waitUntil: "load" });
await page.pdf({
  path: OUT,
  preferCSSPageSize: true,
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: `<div style="font-size:7px;width:100%;text-align:right;padding-right:18mm;color:#71717a;font-family:sans-serif">PW-2026-09 · PageWise Sample Brief</div>`,
  footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#71717a;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
});
await browser.close();
console.log(`Built ${OUT}`);
