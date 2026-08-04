//! The document model — PageWise's single view of a PDF.
//!
//! One parse produces everything the app needs: per-page text (Markdown), a
//! chapter outline, hyperlinks and figure boxes. Nothing downstream re-opens
//! the file, so there is exactly one place where a PDF is interpreted.
//!
//! This module is also the containment wall for `pdf-inspector`'s conventions,
//! which are not internally consistent. Measured on 0.1.7:
//!
//! - `PageMarkdown::page` is 0-based, while `pages_needing_ocr` in the same
//!   struct is 1-based.
//! - The region API takes 0-based page indices; the positions API takes a
//!   1-based page filter.
//! - `TextItem` coordinates use PDF's bottom-left origin; region bounding boxes
//!   use a top-left origin.
//!
//! Rather than track which list is in which base, page identity here comes from
//! **array order** — the i-th entry of `pages` is page i+1 — which no upstream
//! renumbering can break. Every page number leaving this module is 1-based.
//!
//! Coordinates are the one convention we cannot normalize: page height lives
//! behind a private helper upstream, so a bottom-left→top-left flip is
//! impossible here. `Link`/`Figure` rects are therefore emitted in PDF points
//! with a **bottom-left origin**, and the frontend flips them with the page
//! height it already has from pdf.js. `extract_region` takes a **top-left**
//! rect, which is what a viewport selection already is — so that path needs no
//! conversion at all.

use pdf_inspector::extractor::{extract_text_with_positions, extract_text_with_positions_pages};
use pdf_inspector::types::ItemType;
use pdf_inspector::{
    detect_pdf, extract_pages_markdown, extract_tables_in_regions_mem,
    extract_text_in_regions_mem, PdfType,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Above this page count the positions pass (links/figures) is skipped.
///
/// `pdf-inspector` exposes no cancellation token, so a parse cannot be
/// interrupted once started. Text extraction is worth the wait on any document
/// the user chose to open; the positions pass is an enhancement, and on a
/// document this large it is the one that would be felt.
const POSITIONS_PAGE_LIMIT: usize = 1_000;

/// Upper bound on synthesized outline entries, so a pathological document
/// cannot produce an unbounded IPC payload.
const MAX_OUTLINE_ENTRIES: usize = 1_000;

/// Confidence at or above which a "scanned" verdict is trusted enough to skip
/// text extraction entirely and go straight to vision indexing.
const SCANNED_CONFIDENCE: f32 = 0.9;

/// A rectangle in PDF points.
///
/// For `Link` and `Figure` the origin is **bottom-left** (PDF native, as
/// `TextItem` reports it). For `extract_region` input the origin is
/// **top-left**. See the module docs for why the two differ.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Page {
    /// 1-based.
    pub page: u32,
    /// Markdown. Empty when the page carries no recoverable text layer.
    pub text: String,
    /// No text layer worth reading — the vision queue owns this page.
    pub needs_vision: bool,
    /// The page's Markdown contains a table, so a reader should not reflow it.
    pub has_table: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Heading {
    pub title: String,
    /// 1-based.
    pub page: u32,
    /// 1 or 2. Deeper levels are dropped as noise.
    pub level: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub page: u32,
    pub text: String,
    pub url: String,
    /// Bottom-left origin. See module docs.
    pub rect: Rect,
}

#[derive(Debug, Clone, Serialize)]
pub struct Figure {
    pub page: u32,
    /// Bottom-left origin. See module docs.
    pub rect: Rect,
}

#[derive(Debug, Clone, Serialize)]
pub struct DocumentModel {
    pub page_count: u32,
    pub title: Option<String>,
    pub pages: Vec<Page>,
    pub outline: Vec<Heading>,
    pub links: Vec<Link>,
    pub figures: Vec<Figure>,
}

/// One run of text on a page, with where it sits.
///
/// Granularity is a line or text run, not a character — upstream reports no
/// per-glyph advances — so a caller can point at the line a phrase is on, not
/// at the phrase itself.
#[derive(Debug, Clone, Serialize)]
pub struct TextItemRect {
    pub text: String,
    /// Bottom-left origin. See module docs.
    pub rect: Rect,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegionText {
    pub text: String,
    /// Markdown table, when the region encloses one.
    pub table: Option<String>,
}

fn map_err(e: impl std::fmt::Display) -> String {
    format!("PDF read failed: {e}")
}


/// A box large enough to cover any page, for whole-page region extraction.
const WHOLE_PAGE: [f32; 4] = [0.0, 0.0, 20_000.0, 20_000.0];

/// Markdown table rows are the one structure that must survive to the reader:
/// a collapsed table silently merges adjacent numbers.
fn has_table(markdown: &str) -> bool {
    markdown.contains("|---")
}

/// Recover pages whose text was extracted and then discarded.
///
/// `pdf-inspector` blanks a page's Markdown when its quality gate fires
/// (`lib.rs`: `markdown: if needs_ocr { String::new() } else { md }`), on the
/// assumption that OCR will take over. That gate over-fires on symbol-dense
/// pages — a table of contents full of dot leaders, a page of mathematics —
/// and the text it threw away is perfectly readable. The region path does not
/// apply the gate, so one extra call brings those pages back for free rather
/// than sending them to a billed vision call.
fn recover_blank_pages(bytes: &[u8], blank: &[usize]) -> Vec<(usize, String)> {
    if blank.is_empty() {
        return Vec::new();
    }
    // Region page indices are 0-based, which is what `blank` already holds.
    let regions: Vec<(u32, Vec<[f32; 4]>)> = blank
        .iter()
        .map(|&i| (i as u32, vec![WHOLE_PAGE]))
        .collect();

    let Ok(results) = extract_text_in_regions_mem(bytes, &regions) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (slot, page_result) in blank.iter().zip(results.iter()) {
        let text: String = page_result
            .regions
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            out.push((*slot, text));
        }
    }
    out
}

/// A running header must repeat on at least this many pages to be one.
const RUNNING_LINE_MIN_PAGES: usize = 3;
/// And be short enough to be furniture rather than a paragraph.
const RUNNING_LINE_MAX_CHARS: usize = 80;

/// Remove the chapter title a document repeats at the top or bottom of its
/// pages.
///
/// The extractor hands these back as body text — page 10 of the test fixture
/// opens with its own chapter header — and they cost more than the space they
/// take. Searching a chapter name, which is what a reader searches while
/// navigating, returns mostly headers: 3 of 5 hits for one heading in the
/// sample document. Upstream's `strip_headers_footers` removes none of them
/// here, and the per-page extraction path takes no options regardless.
///
/// Deliberately narrow. A line is furniture only if it opens or closes its
/// page, repeats in that same position across several pages, and is short. A
/// page whose entire content is one such line keeps it: an empty page would be
/// a worse lie than a repeated one.
///
/// A heading is never furniture, whatever it repeats. The sample document's
/// "Lösungen der Übungsaufgaben" is both a chapter title and, on the pages
/// that follow, a running footer; without this the chapter vanished from the
/// outline. If the extractor promoted a line by font size, it is structure.
fn strip_running_lines(pages: &mut [String]) {
    let mut first_counts: HashMap<String, usize> = HashMap::new();
    let mut last_counts: HashMap<String, usize> = HashMap::new();

    for text in pages.iter() {
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() < 3 {
            continue;
        }
        if let Some(first) = lines.first().filter(|l| !is_structural_line(l)) {
            *first_counts.entry(running_key(first)).or_default() += 1;
        }
        if let Some(last) = lines.last().filter(|l| !is_structural_line(l)) {
            *last_counts.entry(running_key(last)).or_default() += 1;
        }
    }

    let repeats = |counts: &HashMap<String, usize>, line: &str| {
        if is_structural_line(line) {
            return false;
        }
        let key = running_key(line);
        !key.is_empty()
            && key.chars().count() <= RUNNING_LINE_MAX_CHARS
            && counts.get(&key).copied().unwrap_or(0) >= RUNNING_LINE_MIN_PAGES
    };

    for text in pages.iter_mut() {
        let lines: Vec<&str> = text.lines().collect();
        let content: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, _)| i)
            .collect();
        if content.len() < 3 {
            continue;
        }

        let mut drop_first = false;
        let mut drop_last = false;
        if let Some(&i) = content.first() {
            drop_first = repeats(&first_counts, lines[i]);
        }
        if let Some(&i) = content.last() {
            drop_last = repeats(&last_counts, lines[i]);
        }
        if !drop_first && !drop_last {
            continue;
        }

        let skip_first = drop_first.then(|| content[0]);
        let skip_last = drop_last.then(|| content[content.len() - 1]);
        *text = lines
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != skip_first && Some(*i) != skip_last)
            .map(|(_, l)| *l)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
    }
}

/// Compare running lines by their words, not their decoration: the same header
/// appears both underlined and bold in the sample document.
fn running_key(line: &str) -> String {
    clean_heading(line).to_lowercase()
}

/// Structure, not decoration — exempt from stripping however often it repeats.
///
/// A heading the extractor promoted by font size is the document's own
/// skeleton. A table row is the same kind of thing for a different reason: a
/// table continued across pages repeats its header row at the top of each one,
/// which reads exactly like running furniture. Strip it and the `|---|`
/// delimiter and every data row below are left with no column labels, so the
/// values become uninterpretable in both page reads and search results.
fn is_structural_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('#') || trimmed.starts_with('|')
}

/// Strip the inline Markdown we added so a heading reads as plain text.
fn clean_heading(raw: &str) -> String {
    raw.replace("<u>", "")
        .replace("</u>", "")
        .replace("**", "")
        .replace('`', "")
        .trim()
        .to_string()
}

/// Is this heading a real section title rather than a stray fragment?
///
/// Font-size heading detection promotes anything set larger than body text,
/// which on a technical document sweeps in figure captions, display equations
/// and the tail of a broken sentence. Level 1 survives that cleanly in
/// practice; level 2 needs the filter below, and deeper levels are noise.
fn is_plausible_heading(title: &str, level: u8) -> bool {
    let chars: Vec<char> = title.chars().collect();
    if chars.len() < 2 || chars.len() > 120 {
        return false;
    }
    // A title starts with a word, not with punctuation left over from a
    // sentence ("​) Widerspruch").
    if !chars[0].is_alphanumeric() {
        return false;
    }
    if !chars.iter().any(|c| c.is_alphabetic()) {
        return false;
    }
    if level <= 1 {
        return true;
    }

    // "1.2 Metrische Räume" — a numbered section is a title whatever else it
    // contains.
    let numbered = {
        let head: String = chars.iter().take_while(|c| !c.is_whitespace()).collect();
        !head.is_empty()
            && head.chars().next().is_some_and(|c| c.is_ascii_digit())
            && head.chars().all(|c| c.is_ascii_digit() || c == '.')
    };
    if numbered {
        return true;
    }

    // Otherwise: no colon (figure captions), no equals sign (display
    // equations), and not a sentence that happens to be set large.
    !title.contains(':') && !title.contains('=') && !title.ends_with('.') && chars.len() <= 80
}

/// Build a chapter outline from the headings already present in the page text.
///
/// Many real documents ship no bookmarks at all — a 117-page textbook in our
/// fixtures has none — which leaves navigation with nothing to go on. Font-size
/// heading detection fills that gap at the cost of one pass over text we
/// already hold.
pub fn synthesize_outline(pages: &[Page]) -> Vec<Heading> {
    let mut out: Vec<Heading> = Vec::new();
    for page in pages {
        for line in page.text.lines() {
            let line = line.trim_start();
            if !line.starts_with('#') {
                continue;
            }
            let level = line.chars().take_while(|c| *c == '#').count();
            if level == 0 || level > 2 {
                continue;
            }
            let level = level as u8;
            let title = clean_heading(line.trim_start_matches('#'));
            if !is_plausible_heading(&title, level) {
                continue;
            }
            // A heading repeated across a page break is one section, not two.
            if out.last().is_some_and(|h| h.title == title) {
                continue;
            }
            out.push(Heading {
                title,
                page: page.page,
                level,
            });
            if out.len() >= MAX_OUTLINE_ENTRIES {
                return out;
            }
        }
    }
    out
}

fn collect_positions(path: &str, page_count: usize) -> (Vec<Link>, Vec<Figure>) {
    if page_count > POSITIONS_PAGE_LIMIT {
        return (Vec::new(), Vec::new());
    }
    let Ok(items) = extract_text_with_positions(path) else {
        return (Vec::new(), Vec::new());
    };

    let mut links = Vec::new();
    let mut figures = Vec::new();
    for item in items {
        let rect = Rect {
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
        };
        match item.item_type {
            ItemType::Link(url) => links.push(Link {
                page: item.page,
                text: item.text,
                url,
                rect,
            }),
            ItemType::Image => figures.push(Figure {
                page: item.page,
                rect,
            }),
            _ => {}
        }
    }
    (links, figures)
}

/// Parse a PDF once and return everything PageWise needs from it.
pub fn open_document(path: &str) -> Result<DocumentModel, String> {
    let detected = detect_pdf(path).map_err(map_err)?;
    let title = detected
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    // A confident scan has no text layer to extract. Detection costs about a
    // millisecond and saves parsing the whole document to produce blank pages.
    if matches!(detected.pdf_type, PdfType::Scanned) && detected.confidence >= SCANNED_CONFIDENCE {
        let pages = (1..=detected.page_count)
            .map(|page| Page {
                page,
                text: String::new(),
                needs_vision: true,
                has_table: false,
            })
            .collect();
        return Ok(DocumentModel {
            page_count: detected.page_count,
            title,
            pages,
            outline: Vec::new(),
            links: Vec::new(),
            figures: Vec::new(),
        });
    }

    let extracted = extract_pages_markdown(path, None).map_err(map_err)?;
    // Page identity is array position, never the `page` label — see module docs.
    let mut texts: Vec<String> = extracted
        .pages
        .into_iter()
        .map(|p| p.markdown.trim().to_string())
        .collect();

    if texts.is_empty() {
        return Err("PDF read failed: no pages".to_string());
    }

    let blank: Vec<usize> = texts
        .iter()
        .enumerate()
        .filter(|(_, t)| t.is_empty())
        .map(|(i, _)| i)
        .collect();
    if !blank.is_empty() {
        if let Ok(bytes) = std::fs::read(path) {
            for (slot, text) in recover_blank_pages(&bytes, &blank) {
                texts[slot] = text.trim().to_string();
            }
        }
    }

    strip_running_lines(&mut texts);

    let pages: Vec<Page> = texts
        .into_iter()
        .enumerate()
        .map(|(i, text)| Page {
            page: (i + 1) as u32,
            needs_vision: text.is_empty(),
            has_table: has_table(&text),
            text,
        })
        .collect();

    let outline = synthesize_outline(&pages);
    let (links, figures) = collect_positions(path, pages.len());

    Ok(DocumentModel {
        page_count: pages.len() as u32,
        title,
        pages,
        outline,
        links,
        figures,
    })
}

/// Every text run on one page, with its position.
///
/// Fetched per page rather than carried in [`DocumentModel`]: a 117-page
/// document holds some 23,000 runs, which is a heavy thing to pay for on every
/// open in service of a feature used occasionally.
pub fn page_text_items(path: &str, page: u32) -> Result<Vec<TextItemRect>, String> {
    if page == 0 {
        return Err("page must be 1-based".to_string());
    }
    // This filter is 1-based, unlike the region API's 0-based page index.
    let filter: HashSet<u32> = HashSet::from([page]);
    let items = extract_text_with_positions_pages(path, Some(&filter)).map_err(map_err)?;
    Ok(items
        .into_iter()
        // A run with no area cannot be pointed at: a zero-width box draws
        // nothing, and a caller highlighting it would look broken rather than
        // absent. Measured at 75 of 23,107 runs in a real document.
        .filter(|item| {
            matches!(item.item_type, ItemType::Text)
                && !item.text.trim().is_empty()
                && item.width > 0.0
                && item.height > 0.0
        })
        .map(|item| TextItemRect {
            text: item.text,
            rect: Rect {
                x: item.x,
                y: item.y,
                width: item.width,
                height: item.height,
            },
        })
        .collect())
}

/// Read one rectangle of one page — the text under a selection.
///
/// `rect` uses a **top-left** origin in PDF points, which is what a pdf.js
/// viewport selection already is, so the caller passes its coordinates through
/// unchanged.
pub fn extract_region(path: &str, page: u32, rect: Rect) -> Result<RegionText, String> {
    if page == 0 {
        return Err("page must be 1-based".to_string());
    }
    let bytes = std::fs::read(path).map_err(map_err)?;
    let bbox = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
    // The region API indexes pages from zero.
    let regions = vec![(page - 1, vec![bbox])];

    let results = extract_text_in_regions_mem(&bytes, &regions).map_err(map_err)?;
    let text = results
        .iter()
        .flat_map(|p| p.regions.iter())
        .map(|r| r.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    // A selected table is worth far more as a table than as reflowed prose.
    let table = extract_tables_in_regions_mem(&bytes, &regions)
        .ok()
        .and_then(|tables| {
            let md = tables
                .iter()
                .flat_map(|p| p.regions.iter())
                .map(|r| r.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            (!md.is_empty()).then_some(md)
        });

    Ok(RegionText { text, table })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name)
    }

    fn page(page: u32, text: &str) -> Page {
        Page {
            page,
            text: text.to_string(),
            needs_vision: false,
            has_table: false,
        }
    }

    #[test]
    fn outline_keeps_section_titles_and_drops_page_furniture() {
        let pages = vec![
            page(1, "# Introduction\n\nbody text\n"),
            page(
                2,
                "## 1.2 Metrische Räume\n## Abbildung 2.4:Kartenwechsel\n## 4 2 2 4 6 8\n\
                 ## ) Widerspruch\n## Dann ist stetig.\n## U = R n N\n### Too deep\n",
            ),
        ];
        let outline = synthesize_outline(&pages);
        let titles: Vec<&str> = outline.iter().map(|h| h.title.as_str()).collect();

        assert_eq!(titles, vec!["Introduction", "1.2 Metrische Räume"]);
        assert_eq!(outline[0].level, 1);
        assert_eq!(outline[1].page, 2);
    }

    #[test]
    fn outline_collapses_a_heading_repeated_across_pages() {
        let pages = vec![page(1, "# Anhang\n"), page(2, "# Anhang\n")];
        assert_eq!(synthesize_outline(&pages).len(), 1);
    }

    #[test]
    fn outline_strips_inline_markup_from_titles() {
        let pages = vec![page(1, "# <u>Vorwort</u>\n")];
        assert_eq!(synthesize_outline(&pages)[0].title, "Vorwort");
    }

    // --- Golden fixtures -------------------------------------------------
    //
    // `pdf-inspector` is deliberately not pinned, so these assert on behavior
    // rather than on exact output: an upstream improvement that shifts text by
    // a few percent must not fail CI, but losing table structure or scanned
    // detection must.

    #[test]
    fn text_pdf_extracts_prose() {
        let doc = open_document(&fixture("text-simple.pdf")).expect("open");
        assert_eq!(doc.page_count, 1);
        assert!(doc.pages[0].text.contains("Lorem ipsum"));
        assert!(!doc.pages[0].needs_vision);
        // Tolerance, not a snapshot.
        let len = doc.pages[0].text.chars().count();
        assert!((500..=700).contains(&len), "unexpected text length {len}");
    }

    #[test]
    fn table_columns_stay_separated() {
        let doc = open_document(&fixture("cjk-table.pdf")).expect("open");
        let text = &doc.pages[0].text;
        // The defect this integration exists to remove: the previous extractor
        // ran these two numbers together as "1,2841,141", which reads as one
        // wrong number and produces a confidently wrong answer.
        assert!(!text.contains("1,2841,141"), "table columns collapsed");
        assert!(text.contains("|1,284|1,141|"), "expected a markdown table row");
        assert!(doc.pages[0].has_table);
        assert!(doc.outline.iter().any(|h| h.title.contains("第三季度财务报告")));
    }

    #[test]
    fn scanned_pdf_routes_to_vision() {
        // Classification is internal now, so assert on what it produces: a
        // scan yields no text and every page routed to vision.
        let doc = open_document(&fixture("scanned.pdf")).expect("open");
        assert!(doc.page_count >= 1);
        assert!(doc.pages.iter().all(|p| p.needs_vision));
        assert!(doc.pages.iter().all(|p| p.text.is_empty()));
    }

    #[test]
    fn links_and_figures_carry_positions() {
        let doc = open_document(&fixture("links-figure.pdf")).expect("open");
        assert!(doc.links.len() >= 2, "expected hyperlinks");
        assert!(doc.links.iter().all(|l| l.url.starts_with("https://")));
        assert!(doc.links.iter().all(|l| l.page == 1));
        assert!(!doc.figures.is_empty(), "expected a figure box");
        assert!(doc.figures.iter().all(|f| f.rect.width > 0.0 && f.rect.height > 0.0));
    }

    #[test]
    fn region_selection_reads_only_the_selection() {
        let path = fixture("cjk-table.pdf");
        let whole = extract_region(
            &path,
            1,
            Rect { x: 0.0, y: 0.0, width: 2000.0, height: 2000.0 },
        )
        .expect("region");
        assert!(whole.text.contains("第三季度财务报告"));
        assert!(whole.table.is_some(), "expected the table to be recognized");
        assert!(whole.table.unwrap().contains("1,284"));
    }

    #[test]
    fn region_rejects_a_zero_page() {
        let err = extract_region(
            &fixture("text-simple.pdf"),
            0,
            Rect { x: 0.0, y: 0.0, width: 10.0, height: 10.0 },
        )
        .unwrap_err();
        assert!(err.contains("1-based"));
    }

    #[test]
    fn page_text_items_carry_geometry_for_the_requested_page() {
        let items = page_text_items(&fixture("cjk-table.pdf"), 1).expect("items");
        assert!(!items.is_empty());
        assert!(items.iter().all(|i| i.rect.width > 0.0 && i.rect.height > 0.0));
        // A table cell is its own run, which is what makes a hit locatable.
        assert!(items.iter().any(|i| i.text.contains("1,284")));
    }

    // --- Running headers -------------------------------------------------

    fn pages_of(texts: &[&str]) -> Vec<String> {
        texts.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn strips_a_chapter_title_repeated_at_the_top_of_pages() {
        let mut pages = pages_of(&[
            "<u>1.2. METRISCHE RÄUME</u>\nbody one\nmore text",
            "<u>1.2. METRISCHE RÄUME</u>\nbody two\nmore text",
            "**1.2. Metrische Räume**\nbody three\nmore text",
        ]);
        strip_running_lines(&mut pages);
        // Compared by words, not decoration: the same header appears both
        // underlined and bold in a real document.
        assert!(pages.iter().all(|p| !p.contains("METRISCHE") && !p.contains("Metrische")));
        assert!(pages[0].starts_with("body one"));
    }

    #[test]
    fn strips_a_footer_repeated_at_the_bottom_of_pages() {
        let mut pages = pages_of(&[
            "body one\nmore\nLösungen der Übungsaufgaben",
            "body two\nmore\nLösungen der Übungsaufgaben",
            "body three\nmore\nLösungen der Übungsaufgaben",
        ]);
        strip_running_lines(&mut pages);
        assert!(pages.iter().all(|p| !p.contains("Lösungen")));
        assert!(pages[2].ends_with("more"));
    }

    #[test]
    fn keeps_a_line_that_repeats_only_twice() {
        let mut pages = pages_of(&[
            "Shared\nbody one\nmore",
            "Shared\nbody two\nmore",
        ]);
        strip_running_lines(&mut pages);
        assert!(pages.iter().all(|p| p.contains("Shared")));
    }

    #[test]
    fn keeps_a_repeated_line_that_is_not_at_the_edge_of_the_page() {
        // A recurring phrase mid-paragraph is content, not furniture.
        let mut pages = pages_of(&[
            "top one\nSee also Chapter 3\nend one",
            "top two\nSee also Chapter 3\nend two",
            "top three\nSee also Chapter 3\nend three",
        ]);
        strip_running_lines(&mut pages);
        assert!(pages.iter().all(|p| p.contains("See also Chapter 3")));
    }

    #[test]
    fn keeps_a_long_first_line_even_when_it_repeats() {
        // A repeated paragraph is not page furniture.
        let long = "x".repeat(RUNNING_LINE_MAX_CHARS + 1);
        let mut pages = pages_of(&[
            &format!("{long}\nbody\nmore"),
            &format!("{long}\nbody\nmore"),
            &format!("{long}\nbody\nmore"),
        ]);
        strip_running_lines(&mut pages);
        assert!(pages.iter().all(|p| p.contains(&long)));
    }

    #[test]
    fn never_empties_a_page_whose_only_line_is_the_header() {
        // A blank page would be a worse lie than a repeated header.
        let mut pages = pages_of(&[
            "1.2. METRISCHE RÄUME",
            "1.2. METRISCHE RÄUME",
            "1.2. METRISCHE RÄUME",
            "1.2. METRISCHE RÄUME\nbody\nmore",
        ]);
        strip_running_lines(&mut pages);
        assert!(pages[0].contains("METRISCHE"));
        assert!(pages[1].contains("METRISCHE"));
    }

    #[test]
    fn keeps_a_chapter_title_that_also_runs_as_a_footer() {
        // Measured on the sample document: "Lösungen der Übungsaufgaben" is a
        // chapter heading and, on the pages after it, a running footer. Without
        // the heading exemption the chapter disappeared from the outline.
        let mut pages = pages_of(&[
            "# Lösungen der Übungsaufgaben\nfirst answer\nsecond answer",
            "more answers\nstill more\n<u>Lösungen der Übungsaufgaben</u>",
            "further answers\nstill more\n<u>Lösungen der Übungsaufgaben</u>",
            "final answers\nstill more\n<u>Lösungen der Übungsaufgaben</u>",
        ]);
        strip_running_lines(&mut pages);
        assert!(
            pages[0].contains("# Lösungen der Übungsaufgaben"),
            "the chapter heading must survive",
        );
        assert!(
            pages[1..].iter().all(|p| !p.contains("Lösungen")),
            "the running footer must not",
        );
    }

    #[test]
    fn keeps_the_header_row_of_a_table_continued_across_pages() {
        // A table spanning pages repeats its header row at the top of each one,
        // which looks exactly like running furniture. Stripping it leaves the
        // delimiter and every data row with no column labels at all.
        let header = "| Year | Revenue |";
        let mut pages: Vec<String> = ["10", "12", "14", "16"]
            .iter()
            .map(|v| format!("{header}\n|---|---|\n| 2021 | {v} |"))
            .collect();
        strip_running_lines(&mut pages);
        assert!(
            pages.iter().all(|p| p.starts_with(header)),
            "column labels must survive on every page of the table",
        );
    }

    #[test]
    fn running_headers_are_gone_from_the_real_document() {
        // The fixture has none; this guards the call site, not the rule.
        let doc = open_document(&fixture("text-simple.pdf")).expect("open");
        assert!(doc.pages[0].text.contains("Lorem ipsum"));
    }

    #[test]
    fn page_text_items_skips_runs_with_no_area() {
        // A zero-width run draws an invisible box; a caller highlighting it
        // looks broken rather than absent. 75 of 23,107 runs in a real
        // document have no width.
        let items = page_text_items(&fixture("form-fields.pdf"), 1).expect("items");
        assert!(items.iter().all(|i| i.rect.width > 0.0 && i.rect.height > 0.0));
    }

    #[test]
    fn filled_form_values_reach_the_page_text() {
        // Form field values arrive through the ordinary text path, so the
        // assistant can read them with no special handling.
        let doc = open_document(&fixture("form-fields.pdf")).expect("open");
        let text = &doc.pages[0].text;
        assert!(text.contains("Ada Lovelace"), "form value missing from page text");
        assert!(text.contains("1,284.00"));
    }

    #[test]
    fn page_text_items_rejects_a_zero_page() {
        let err = page_text_items(&fixture("cjk-table.pdf"), 0).unwrap_err();
        assert!(err.contains("1-based"));
    }

    #[test]
    fn page_text_items_is_empty_past_the_end_rather_than_failing() {
        let items = page_text_items(&fixture("cjk-table.pdf"), 99).expect("items");
        assert!(items.is_empty());
    }

    #[test]
    fn damaged_file_fails_cleanly() {
        assert!(open_document(&fixture("damaged.pdf")).is_err());
    }
}
