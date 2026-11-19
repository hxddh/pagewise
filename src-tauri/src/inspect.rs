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
//! impossible here. `Link`/`Figure` rects and text runs are therefore emitted
//! in PDF points with a **bottom-left origin**, and the frontend flips them
//! with the page height it already has from pdf.js. `extract_region` takes a
//! **top-left** rect, which is what a viewport selection already is — so that
//! path needs no conversion at all.
//!
//! **Absolute user space, since 13.1.** pdf-inspector releases after 1.17 report
//! positions relative to the page's visible box (CropBox ∩ MediaBox), the
//! frame a renderer draws. pdf.js's `convertToViewportPoint`, which every
//! bottom-left rect here is drawn through, subtracts that box's origin itself,
//! and so do the pdf.js annotations PageWise draws beside these — so a
//! relative rect would be shifted twice on any page whose box does not start
//! at (0, 0). Measured on a page cropped to `[100 100 512 692]`: a line at
//! (150, 600) came back as (50, 500). [`visible_origins`] adds the origin back
//! before anything leaves this module. Region inputs need nothing: the
//! frontend already sends them relative to pdf.js's view box, which is the
//! same box, and the frame 1.25 reads them in.

use pdf_inspector::extractor::extract_text_with_positions_mem;
use pdf_inspector::types::ItemType;
use pdf_inspector::{
    detect_pdf_mem, extract_pages_markdown_mem, extract_structure_elements_mem,
    extract_tables_in_regions_mem, extract_text_in_regions_mem, PdfType,
};
use serde::{Deserialize, Serialize};

use crate::doc_check;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::SystemTime;

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
    pub url: String,
    /// The line the link sits on, or empty when none could be matched.
    ///
    /// Not the anchor text — see `link_context`. Upstream's own `text` for a
    /// link item is the URI echoed back, which told a reader nothing.
    pub context: String,
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
    /// Headings the document itself declares, when it is a tagged PDF.
    ///
    /// Separate from `outline` rather than merged into it: the frontend
    /// arbitrates between this, the authored bookmarks pdf.js reads, and the
    /// synthesized fallback, and it can only do that if it can tell them apart.
    pub structure_outline: Vec<Heading>,
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
        || markdown.lines().any(|l| {
            let t = l.trim();
            t.starts_with('|')
                && t.contains("---")
                && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
        })
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
    let tables = extract_tables_in_regions_mem(bytes, &regions).ok();

    let mut out = Vec::new();
    for (idx, (slot, page_result)) in blank.iter().zip(results.iter()).enumerate() {
        let table_md = tables
            .as_ref()
            .and_then(|ts| ts.get(idx))
            .map(|p| {
                p.regions
                    .iter()
                    .map(|r| r.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
                    .trim()
                    .to_string()
            })
            .filter(|md| has_table(md));
        let text: String = page_result
            .regions
            .iter()
            .map(|r| r.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(md) = table_md {
            let prose = reflow_lines(&text);
            let combined = if prose.is_empty() { md } else { format!("{prose}\n\n{md}") };
            out.push((*slot, combined));
        } else if !text.trim().is_empty() {
            out.push((*slot, reflow_lines(&text)));
        }
    }
    out
}

/// Put the region path's printed lines back into paragraphs.
///
/// The region path returns one printed line per `\n`. That was tolerable
/// while it only rescued the odd symbol-dense page; since pdf-inspector 1.25
/// classifies OCR'd scans as image-based, it carries whole documents, and a
/// model reading "dan-\ngerous" quotes "dan- gerous" — which the citation check
/// then has to forgive. Lines are joined; a word broken with a hyphen at a line
/// end is rejoined; a line that ends a sentence well short of the others ends
/// its paragraph; CJK lines join without a space, as they were set.
fn reflow_lines(text: &str) -> String {
    // `[Image: Im001]` placeholders say an image is there, which `figures`
    // already says with its position; joined into a paragraph they become part
    // of the last sentence on the page.
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !(l.starts_with("[Image:") && l.ends_with(']')))
        .collect();
    let longest = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);
    let is_cjk = |c: char| matches!(c as u32, 0x3000..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF);
    let mut out = String::new();
    let mut prev: Option<&str> = None;
    for line in lines {
        if line.is_empty() {
            if !out.is_empty() && !out.ends_with("\n\n") {
                out.push_str("\n\n");
            }
            prev = None;
            continue;
        }
        if let Some(p) = prev {
            let p_last = p.chars().last().unwrap_or(' ');
            let before_hyphen = p.chars().rev().nth(1).unwrap_or(' ');
            let first = line.chars().next().unwrap_or(' ');
            let short = p.chars().count() * 10 < longest * 7;
            let ends_sentence = matches!(p_last, '.' | '!' | '?' | ':' | '"' | '\u{201D}' | '。' | '！' | '？');
            if ends_sentence && short {
                out.push_str("\n\n");
            } else if p_last == '-' && before_hyphen.is_alphabetic() && first.is_lowercase() {
                out.pop();
            } else if !(is_cjk(p_last) && is_cjk(first)) {
                out.push(' ');
            }
        }
        out.push_str(line);
        prev = Some(line);
    }
    out.trim().to_string()
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
/// Headings and table rows are never furniture, whatever they repeat — see
/// `is_structural_line`. The sample document's
/// "Lösungen der Übungsaufgaben" is both a chapter title and, on the pages
/// that follow, a running footer; without this the chapter vanished from the
/// outline. If the extractor promoted a line by font size, it is structure.
fn strip_running_lines(pages: &mut [String]) {
    let mut first_stats: HashMap<String, (usize, bool, std::collections::HashSet<String>)> = HashMap::new();
    let mut last_stats: HashMap<String, (usize, bool, std::collections::HashSet<String>)> = HashMap::new();
    let total_pages = pages.len();

    for text in pages.iter() {
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() < 3 {
            continue;
        }
        if let Some(first) = lines.first().filter(|l| !is_structural_line(l)) {
            let (key, has_page_num) = running_key_info(first);
            let entry = first_stats.entry(key).or_insert_with(|| (0, false, Default::default()));
            entry.0 += 1;
            entry.1 |= has_page_num;
            entry.2.insert(clean_heading(first));
        }
        if let Some(last) = lines.last().filter(|l| !is_structural_line(l)) {
            let (key, has_page_num) = running_key_info(last);
            let entry = last_stats.entry(key).or_insert_with(|| (0, false, Default::default()));
            entry.0 += 1;
            entry.1 |= has_page_num;
            entry.2.insert(clean_heading(last));
        }
    }

    let repeats = |stats: &HashMap<String, (usize, bool, std::collections::HashSet<String>)>, line: &str| {
        if is_structural_line(line) {
            return false;
        }
        let (key, _) = running_key_info(line);
        if key.is_empty() || key.chars().count() > RUNNING_LINE_MAX_CHARS {
            return false;
        }
        let Some((count, has_page_num, distinct)) = stats.get(&key) else {
            return false;
        };
        if *count >= RUNNING_LINE_MIN_PAGES {
            return true;
        }
        // On a 2-page brief (e.g. "1 / 2" and "2 / 2"), strip only genuine
        // page-numbered furniture whose page number varies across both pages.
        total_pages == 2 && *count == 2 && *has_page_num && distinct.len() > 1
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
            drop_first = repeats(&first_stats, lines[i]);
        }
        if let Some(&i) = content.last() {
            drop_last = repeats(&last_stats, lines[i]);
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

/// Compare running lines by their words, normalizing page-number numerators
/// ("Page 1 of 12", "1 / 2", "第 3 页") while leaving prose numbers and
/// numbered list markers ("1. Scope", "Page 1 line 0 revenue of 7") intact.
fn running_key_info(line: &str) -> (String, bool) {
    let cleaned = clean_heading(line).to_lowercase();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return (String::new(), false);
    }
    // Never treat numbered list items ("1. Foo", "2) Bar", "(3) Baz") as page-numbered furniture.
    if trimmed
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit() || c == '(')
    {
        let rest = trimmed.trim_start_matches('(').trim_start_matches(|c: char| c.is_ascii_digit());
        if rest.starts_with(". ") || rest.starts_with(") ") {
            return (trimmed.to_string(), false);
        }
    }
    // Standalone / decorated page number: "12", "- 12 -", "— 12 —", "[12]".
    let bare = trimmed.trim_matches(|c: char| matches!(c, '-' | '–' | '—' | '[' | ']' | ' ' | '·'));
    if !bare.is_empty() && bare.len() <= 5 && bare.chars().all(|c| c.is_ascii_digit()) {
        return ("#".to_string(), true);
    }

    let mut changed = false;
    // Fraction footer/header: "1 / 2" or "1/12" (only when short furniture).
    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    if tokens.len() == 3
        && tokens[1] == "/"
        && tokens[0].chars().all(|c| c.is_ascii_digit())
        && tokens[2].chars().all(|c| c.is_ascii_digit())
    {
        return (format!("# / {}", tokens[2]), true);
    }

    // Token-level normalization for "page 1 of 12", "p. 3", "pg. 3", "seite 4"
    // ONLY on short lines without multiple body numbers (e.g. not "page 1 line 0 revenue of 7").
    let mut norm_tokens: Vec<String> = Vec::with_capacity(tokens.len());
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if matches!(tok, "page" | "p." | "pg." | "seite")
            && i + 1 < tokens.len()
            && tokens[i + 1].chars().all(|c| c.is_ascii_digit())
            && !tokens.iter().any(|w| *w == "line")
        {
            norm_tokens.push(tok.to_string());
            norm_tokens.push("#".to_string());
            changed = true;
            i += 2;
            continue;
        }
        // "1/12" single token
        if let Some((a, b)) = tok.split_once('/') {
            if !a.is_empty()
                && !b.is_empty()
                && a.chars().all(|c| c.is_ascii_digit())
                && b.chars().all(|c| c.is_ascii_digit())
            {
                norm_tokens.push(format!("#/{b}"));
                changed = true;
                i += 1;
                continue;
            }
        }
        // CJK "第12页" or "第 12 页"
        if tok == "第"
            && i + 2 < tokens.len()
            && tokens[i + 1].chars().all(|c| c.is_ascii_digit())
            && tokens[i + 2].starts_with('页')
        {
            norm_tokens.push("第".to_string());
            norm_tokens.push("#".to_string());
            norm_tokens.push(tokens[i + 2].to_string());
            changed = true;
            i += 3;
            continue;
        }
        if let Some(after) = tok.strip_prefix('第') {
            if let Some((digits, tail)) = after.split_once('页') {
                if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
                    norm_tokens.push(format!("第#页{tail}"));
                    changed = true;
                    i += 1;
                    continue;
                }
            }
        }
        norm_tokens.push(tok.to_string());
        i += 1;
    }
    // Trailing "| 3" or "— 3" or "- 3" at the end of a header/footer
    let len = norm_tokens.len();
    if len >= 3
        && matches!(norm_tokens[len - 2].as_str(), "|" | "—" | "–" | "-" | "·")
        && norm_tokens[len - 1].chars().all(|c| c.is_ascii_digit())
    {
        norm_tokens[len - 1] = "#".to_string();
        changed = true;
    }

    (norm_tokens.join(" "), changed)
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

/// The document's own headings, from its structure tree.
///
/// A tagged PDF says which runs of text are headings and at what level —
/// `/StructTreeRoot` marks them `H1`..`H6` — and that is the author's answer
/// rather than a guess made from font sizes. [`synthesize_outline`] exists
/// because most documents ship no bookmarks; this exists because some of those
/// documents were never guessing material in the first place.
///
/// Empty for a PDF that is not tagged, which is most of them, so the caller
/// falls back exactly as before.
///
/// Levels are clamped to 1 and 2 to match [`Heading`], whose own doc says
/// deeper levels are dropped as noise: an outline is for navigating, and an H4
/// under an H3 under an H2 is a paragraph with ambitions.
type PdfCacheKey = (PathBuf, u64, Option<SystemTime>);

struct LopdfMeta {
    origins: Vec<(f32, f32)>,
    goto_links: Vec<Link>,
}

struct PositionsData {
    by_page: HashMap<u32, Vec<TextItemRect>>,
    mcid_runs: Vec<(u32, i64, String)>,
    links: Vec<Link>,
    figures: Vec<Figure>,
}

struct CachedPdf {
    key: PdfCacheKey,
    bytes: Vec<u8>,
    lopdf_meta: OnceLock<LopdfMeta>,
    positions: OnceLock<Result<PositionsData, String>>,
}

static ACTIVE_PDF: LazyLock<Mutex<Option<Arc<CachedPdf>>>> = LazyLock::new(|| Mutex::new(None));
static LOADING_PDF: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn lock_unpoisoned<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn pdf_key(path: &str) -> Result<PdfCacheKey, String> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).map_err(map_err)?;
    let len = meta.len();
    if len > doc_check::MAX_DOCUMENT_BYTES {
        return Err(doc_check::coded(
            doc_check::FILE_TOO_LARGE,
            format!("{len} bytes; max {}", doc_check::MAX_DOCUMENT_BYTES),
        ));
    }
    let canon = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    Ok((canon, len, meta.modified().ok()))
}

fn get_or_load_pdf(path: &str) -> Result<Arc<CachedPdf>, String> {
    let key = pdf_key(path)?;
    if let Some(existing) = lock_unpoisoned(&ACTIVE_PDF).as_ref() {
        if existing.key == key {
            return Ok(Arc::clone(existing));
        }
    }
    let _guard = lock_unpoisoned(&LOADING_PDF);
    if let Some(existing) = lock_unpoisoned(&ACTIVE_PDF).as_ref() {
        if existing.key == key {
            return Ok(Arc::clone(existing));
        }
    }
    let bytes = std::fs::read(path).map_err(map_err)?;
    if bytes.len() as u64 > doc_check::MAX_DOCUMENT_BYTES {
        return Err(doc_check::coded(
            doc_check::FILE_TOO_LARGE,
            format!("{} bytes; max {}", bytes.len(), doc_check::MAX_DOCUMENT_BYTES),
        ));
    }
    let cached = Arc::new(CachedPdf {
        key,
        bytes,
        lopdf_meta: OnceLock::new(),
        positions: OnceLock::new(),
    });
    *lock_unpoisoned(&ACTIVE_PDF) = Some(Arc::clone(&cached));
    Ok(cached)
}

impl CachedPdf {
    fn lopdf_meta(&self) -> &LopdfMeta {
        self.lopdf_meta.get_or_init(|| parse_lopdf_meta(&self.bytes))
    }

    fn positions(&self) -> Result<&PositionsData, String> {
        self.positions
            .get_or_init(|| build_positions_data(&self.bytes, self.lopdf_meta()))
            .as_ref()
            .map_err(Clone::clone)
    }
}

fn pdf_string_text(obj: &lopdf::Object) -> Option<String> {
    match obj {
        lopdf::Object::String(bytes, _) => {
            if bytes.starts_with(&[0xFE, 0xFF]) && bytes.len() >= 2 {
                let units: Vec<u16> = bytes[2..]
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect();
                String::from_utf16(&units).ok()
            } else {
                Some(String::from_utf8_lossy(bytes).into_owned())
            }
        }
        lopdf::Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        _ => None,
    }
}

fn resolve_dest_array_page(
    arr: &[lopdf::Object],
    obj_to_page: &HashMap<lopdf::ObjectId, u32>,
    page_count: u32,
) -> Option<u32> {
    match arr.first()? {
        lopdf::Object::Reference(id) => obj_to_page.get(id).copied(),
        lopdf::Object::Integer(idx) if *idx >= 0 => {
            let p = (*idx as u32) + 1;
            (p >= 1 && p <= page_count).then_some(p)
        }
        _ => None,
    }
}

fn collect_name_tree_dests(
    doc: &lopdf::Document,
    node_obj: &lopdf::Object,
    obj_to_page: &HashMap<lopdf::ObjectId, u32>,
    page_count: u32,
    depth: usize,
    out: &mut HashMap<String, u32>,
) {
    if depth > 16 {
        return;
    }
    let dict = match node_obj {
        lopdf::Object::Reference(id) => match doc.get_dictionary(*id) {
            Ok(d) => d,
            Err(_) => return,
        },
        lopdf::Object::Dictionary(d) => d,
        _ => return,
    };
    if let Ok(names_obj) = dict.get(b"Names") {
        let arr = match names_obj {
            lopdf::Object::Reference(id) => doc.get_object(*id).ok().and_then(|o| o.as_array().ok()),
            lopdf::Object::Array(a) => Some(a),
            _ => None,
        };
        if let Some(arr) = arr {
            for pair in arr.chunks_exact(2) {
                if let Some(name) = pdf_string_text(&pair[0]) {
                    if let Some(p) = resolve_dest_value(doc, &pair[1], obj_to_page, page_count, None) {
                        out.insert(name, p);
                    }
                }
            }
        }
    }
    if let Ok(kids_obj) = dict.get(b"Kids") {
        let arr = match kids_obj {
            lopdf::Object::Reference(id) => doc.get_object(*id).ok().and_then(|o| o.as_array().ok()),
            lopdf::Object::Array(a) => Some(a),
            _ => None,
        };
        if let Some(arr) = arr {
            for kid in arr {
                collect_name_tree_dests(doc, kid, obj_to_page, page_count, depth + 1, out);
            }
        }
    }
}

fn resolve_dest_value(
    doc: &lopdf::Document,
    val: &lopdf::Object,
    obj_to_page: &HashMap<lopdf::ObjectId, u32>,
    page_count: u32,
    named_dests: Option<&HashMap<String, u32>>,
) -> Option<u32> {
    let resolved = match val {
        lopdf::Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    match resolved {
        lopdf::Object::Array(arr) => resolve_dest_array_page(arr, obj_to_page, page_count),
        lopdf::Object::Dictionary(d) => {
            let inner = d.get(b"D").ok()?;
            resolve_dest_value(doc, inner, obj_to_page, page_count, named_dests)
        }
        lopdf::Object::String(_, _) | lopdf::Object::Name(_) => {
            let name = pdf_string_text(resolved)?;
            named_dests?.get(&name).copied()
        }
        _ => None,
    }
}

fn build_named_dests(
    doc: &lopdf::Document,
    obj_to_page: &HashMap<lopdf::ObjectId, u32>,
    page_count: u32,
) -> HashMap<String, u32> {
    let mut out = HashMap::new();
    let Ok(catalog) = doc.catalog() else {
        return out;
    };
    if let Ok(dests_obj) = catalog.get(b"Dests") {
        let dict = match dests_obj {
            lopdf::Object::Reference(id) => doc.get_dictionary(*id).ok(),
            lopdf::Object::Dictionary(d) => Some(d),
            _ => None,
        };
        if let Some(dict) = dict {
            for (k, v) in dict.iter() {
                let key = String::from_utf8_lossy(k).into_owned();
                if let Some(p) = resolve_dest_value(doc, v, obj_to_page, page_count, None) {
                    out.insert(key, p);
                }
            }
        }
    }
    if let Ok(names_obj) = catalog.get(b"Names") {
        let names_dict = match names_obj {
            lopdf::Object::Reference(id) => doc.get_dictionary(*id).ok(),
            lopdf::Object::Dictionary(d) => Some(d),
            _ => None,
        };
        if let Some(names_dict) = names_dict {
            if let Ok(dests_tree) = names_dict.get(b"Dests") {
                collect_name_tree_dests(doc, dests_tree, obj_to_page, page_count, 0, &mut out);
            }
        }
    }
    out
}

fn annot_rect(doc: &lopdf::Document, dict: &lopdf::Dictionary) -> Option<Rect> {
    let obj = dict.get(b"Rect").ok()?;
    let arr = match obj {
        lopdf::Object::Reference(id) => doc.get_object(*id).ok()?.as_array().ok()?,
        lopdf::Object::Array(a) => a,
        _ => return None,
    };
    let num = |o: &lopdf::Object| -> Option<f32> {
        let o = match o {
            lopdf::Object::Reference(id) => doc.get_object(*id).ok()?,
            other => other,
        };
        match o {
            lopdf::Object::Integer(i) => Some(*i as f32),
            lopdf::Object::Real(r) => Some(*r),
            _ => None,
        }
    };
    if arr.len() < 4 {
        return None;
    }
    let (x0, y0, x1, y1) = (num(&arr[0])?, num(&arr[1])?, num(&arr[2])?, num(&arr[3])?);
    let x = x0.min(x1);
    let y = y0.min(y1);
    let width = (x1 - x0).abs();
    let height = (y1 - y0).abs();
    (width > 0.0 && height > 0.0).then_some(Rect { x, y, width, height })
}

fn parse_lopdf_meta(bytes: &[u8]) -> LopdfMeta {
    let Ok(mut doc) = lopdf::Document::load_mem(bytes) else {
        return LopdfMeta {
            origins: Vec::new(),
            goto_links: Vec::new(),
        };
    };
    if doc.is_encrypted() {
        let _ = doc.decrypt("");
    }
    let pages: BTreeMap<u32, lopdf::ObjectId> = doc.get_pages();
    let page_count = pages.len() as u32;
    let origins: Vec<(f32, f32)> = pages.values().map(|&id| visible_origin(&doc, id)).collect();
    if pages.len() > POSITIONS_PAGE_LIMIT {
        return LopdfMeta {
            origins,
            goto_links: Vec::new(),
        };
    }
    let obj_to_page: HashMap<lopdf::ObjectId, u32> =
        pages.iter().map(|(&num, &id)| (id, num)).collect();
    let named_dests = build_named_dests(&doc, &obj_to_page, page_count);
    let mut goto_links = Vec::new();

    for (&page_num, &page_id) in &pages {
        let Ok(page_dict) = doc.get_dictionary(page_id) else {
            continue;
        };
        let annots = match page_dict.get(b"Annots") {
            Ok(lopdf::Object::Array(a)) => Some(a.clone()),
            Ok(lopdf::Object::Reference(id)) => {
                doc.get_object(*id).ok().and_then(|o| o.as_array().ok()).cloned()
            }
            _ => None,
        };
        let Some(annots) = annots else { continue };
        for annot in &annots {
            let dict = match annot {
                lopdf::Object::Reference(id) => match doc.get_dictionary(*id) {
                    Ok(d) => d,
                    Err(_) => continue,
                },
                lopdf::Object::Dictionary(d) => d,
                _ => continue,
            };
            if dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) != Some(b"Link") {
                continue;
            }
            let Some(rect) = annot_rect(&doc, dict) else {
                continue;
            };
            let mut target_page = dict
                .get(b"Dest")
                .ok()
                .and_then(|d| resolve_dest_value(&doc, d, &obj_to_page, page_count, Some(&named_dests)));
            if target_page.is_none() {
                if let Ok(action_obj) = dict.get(b"A") {
                    let action_dict = match action_obj {
                        lopdf::Object::Reference(id) => doc.get_dictionary(*id).ok(),
                        lopdf::Object::Dictionary(d) => Some(d),
                        _ => None,
                    };
                    if let Some(ad) = action_dict {
                        let subtype = ad.get(b"S").ok().and_then(|o| o.as_name().ok());
                        if subtype == Some(b"GoTo") {
                            target_page = ad.get(b"D").ok().and_then(|d| {
                                resolve_dest_value(&doc, d, &obj_to_page, page_count, Some(&named_dests))
                            });
                        } else if subtype == Some(b"URI") {
                            if let Some(uri) = ad.get(b"URI").ok().and_then(pdf_string_text) {
                                if let Some(frag) = uri.strip_prefix('#') {
                                    target_page = named_dests.get(frag).copied();
                                }
                            }
                        }
                    }
                }
            }
            if let Some(tp) = target_page {
                goto_links.push(Link {
                    page: page_num,
                    url: format!("pagewise-goto:{tp}"),
                    context: String::new(),
                    rect,
                });
            }
        }
    }

    LopdfMeta {
        origins,
        goto_links,
    }
}

fn build_positions_data(bytes: &[u8], meta: &LopdfMeta) -> Result<PositionsData, String> {
    let items = extract_text_with_positions_mem(bytes).map_err(map_err)?;
    let mut by_page: HashMap<u32, Vec<TextItemRect>> = HashMap::new();
    let mut mcid_runs: Vec<(u32, i64, String)> = Vec::new();
    let mut links = Vec::new();
    let mut figures = Vec::new();
    let mut lines: Vec<(u32, Rect, String)> = Vec::new();

    for item in items {
        let (dx, dy) = origin_of(&meta.origins, item.page);
        let rect = Rect {
            x: item.x + dx,
            y: item.y + dy,
            width: item.width,
            height: item.height,
        };
        if let Some(mcid) = item.mcid {
            mcid_runs.push((item.page, mcid, item.text.clone()));
        }
        match item.item_type {
            ItemType::Link(url) => {
                if !url.starts_with('#') {
                    links.push(Link {
                        page: item.page,
                        url,
                        context: String::new(),
                        rect,
                    });
                }
            }
            ItemType::Image => figures.push(Figure {
                page: item.page,
                rect,
            }),
            ItemType::Text => {
                if !item.text.trim().is_empty() {
                    lines.push((item.page, rect, item.text.clone()));
                    if item.width > 0.0 && item.height > 0.0 {
                        by_page.entry(item.page).or_default().push(TextItemRect {
                            text: item.text,
                            rect,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    for g in &meta.goto_links {
        let dup = links.iter().any(|l| {
            l.page == g.page
                && l.url == g.url
                && (l.rect.x - g.rect.x).abs() < 1.0
                && (l.rect.y - g.rect.y).abs() < 1.0
        });
        if !dup {
            links.push(g.clone());
        }
    }

    for link in links.iter_mut() {
        link.context = link_context(link, &lines);
    }

    Ok(PositionsData {
        by_page,
        mcid_runs,
        links,
        figures,
    })
}

fn structure_outline(cached: &CachedPdf, page_count: usize) -> Vec<Heading> {
    if page_count > POSITIONS_PAGE_LIMIT {
        return Vec::new();
    }
    let Ok(elements) = extract_structure_elements_mem(&cached.bytes, None) else {
        return Vec::new();
    };
    if elements.is_empty() {
        return Vec::new();
    }
    // (page, mcid) -> level. Only heading roles; everything else is body.
    let roles: HashMap<(u32, i64), u8> = elements
        .into_iter()
        .filter_map(|e| heading_level(&e.role).map(|l| ((e.page, e.mcid), l)))
        .collect();
    if roles.is_empty() {
        return Vec::new();
    }

    let Ok(pos) = cached.positions() else {
        return Vec::new();
    };

    let mut out: Vec<Heading> = Vec::new();
    // Runs carrying the same mcid are one heading split across draw calls;
    // joining them is what turns "Chapter", " ", "One" back into a title.
    let mut current: Option<((u32, i64), u8, String)> = None;
    for (page, mcid, text_piece) in &pos.mcid_runs {
        let key = (*page, *mcid);
        let Some(&level) = roles.get(&key) else {
            continue;
        };
        match current.as_mut() {
            Some((k, _, text)) if *k == key => {
                if !text.ends_with(' ') && !text_piece.starts_with(' ') {
                    text.push(' ');
                }
                text.push_str(text_piece);
            }
            _ => {
                if let Some((k, level, text)) = current.take() {
                    push_structure_heading(&mut out, k.0, level, &text);
                }
                current = Some((key, level, text_piece.clone()));
            }
        }
        if out.len() >= MAX_OUTLINE_ENTRIES {
            return out;
        }
    }
    if let Some((k, level, text)) = current.take() {
        push_structure_heading(&mut out, k.0, level, &text);
    }
    out
}

/// `H1`..`H6` (and bare `H`) to the two levels an outline keeps, or None.
fn heading_level(role: &str) -> Option<u8> {
    match role {
        "H" | "H1" => Some(1),
        "H2" => Some(2),
        // Deeper headings are real, but an outline listing them is a wall of
        // text rather than a way to navigate. Folded into level 2 so a document
        // tagged only H3 downward still gets an outline instead of nothing.
        "H3" | "H4" | "H5" | "H6" => Some(2),
        _ => None,
    }
}

fn push_structure_heading(out: &mut Vec<Heading>, page: u32, level: u8, text: &str) {
    let title = clean_heading(text);
    if !is_plausible_heading(&title, level) {
        return;
    }
    // A heading repeated across a page break is one section, not two — the same
    // rule `synthesize_outline` applies, for the same reason.
    if out.last().is_some_and(|h| h.title == title) {
        return;
    }
    out.push(Heading { title, page, level });
}

fn collect_positions(cached: &CachedPdf, page_count: usize) -> (Vec<Link>, Vec<Figure>) {
    if page_count > POSITIONS_PAGE_LIMIT {
        return (Vec::new(), Vec::new());
    }
    let Ok(pos) = cached.positions() else {
        return (Vec::new(), Vec::new());
    };
    (pos.links.clone(), pos.figures.clone())
}

/// A link box must cover at least this much of a line to be sitting on it.
const LINK_CONTEXT_MIN_OVERLAP: f32 = 0.3;
/// Longer context is a paragraph, not a place — cut it.
const LINK_CONTEXT_MAX_CHARS: usize = 200;

/// The line a link sits on.
///
/// Not the anchor text: upstream reports text per line or run, never per
/// character, so the span under the link box cannot be isolated — measured on
/// the sample document, a 24-character anchor comes back as its whole
/// 90-character line. That is why the destination stays in metadata instead of
/// being written back into the page as `[anchor](url)`, which would swallow the
/// sentence. The line is still the useful thing to show: it says whose link it
/// is in a way the URL alone often does not.
fn link_context(link: &Link, lines: &[(u32, Rect, String)]) -> String {
    let mut best: Option<(f32, &str)> = None;
    for (page, rect, text) in lines {
        if *page != link.page {
            continue;
        }
        let share = covered_share(&link.rect, rect);
        if share < LINK_CONTEXT_MIN_OVERLAP {
            continue;
        }
        if best.is_none_or(|(top, _)| share > top) {
            best = Some((share, text));
        }
    }
    let Some((_, text)) = best else {
        return String::new();
    };
    let cleaned = clean_heading(text).split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= LINK_CONTEXT_MAX_CHARS {
        return cleaned;
    }
    let cut: String = cleaned.chars().take(LINK_CONTEXT_MAX_CHARS).collect();
    format!("{cut}…")
}

/// How much of `link` falls inside `line`, as a fraction of the link's area.
fn covered_share(link: &Rect, line: &Rect) -> f32 {
    let x1 = link.x.max(line.x);
    let y1 = link.y.max(line.y);
    let x2 = (link.x + link.width).min(line.x + line.width);
    let y2 = (link.y + link.height).min(line.y + line.height);
    if x2 <= x1 || y2 <= y1 {
        return 0.0;
    }
    let area = link.width * link.height;
    if area <= 0.0 {
        return 0.0;
    }
    ((x2 - x1) * (y2 - y1)) / area
}

/// Parse a PDF once and return everything PageWise needs from it.
pub fn open_document(path: &str) -> Result<DocumentModel, String> {
    let cached = get_or_load_pdf(path)?;
    // Coded, so the reader sees "password-protected" or "damaged" in their
    // language with a next step instead of the extractor's sentence (24.0).
    let detected = detect_pdf_mem(&cached.bytes).map_err(|e| doc_check::pdf_error(&e))?;
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
            structure_outline: Vec::new(),
            links: Vec::new(),
            figures: Vec::new(),
        });
    }

    let extracted = extract_pages_markdown_mem(&cached.bytes, None).map_err(|e| doc_check::pdf_error(&e))?;
    // Page identity is array position, never the `page` label — see module docs.
    let mut texts: Vec<String> = extracted
        .pages
        .into_iter()
        .map(|p| p.markdown.trim().to_string())
        .collect();

    if texts.is_empty() {
        return Err(doc_check::coded(doc_check::PDF_DAMAGED, "no pages"));
    }

    let blank: Vec<usize> = texts
        .iter()
        .enumerate()
        .filter(|(_, t)| t.is_empty())
        .map(|(i, _)| i)
        .collect();
    if !blank.is_empty() {
        for (slot, text) in recover_blank_pages(&cached.bytes, &blank) {
            texts[slot] = text.trim().to_string();
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
    let structure_outline = structure_outline(&cached, pages.len());
    let (links, figures) = collect_positions(&cached, pages.len());

    Ok(DocumentModel {
        page_count: pages.len() as u32,
        title,
        pages,
        outline,
        structure_outline,
        links,
        figures,
    })
}

fn visible_origin(doc: &lopdf::Document, page: lopdf::ObjectId) -> (f32, f32) {
    let visible = visible_box(doc, page);
    (visible[0], visible[1])
}

/// The page's visible box, `[x0, y0, x1, y1]` in user space: the CropBox
/// clipped to the MediaBox, as pdf.js computes `page.view`. Marks are stored
/// relative to it (`selection-quote.ts`), so writing them back into the file
/// needs it too (`annotate.rs`).
pub(crate) fn visible_box(doc: &lopdf::Document, page: lopdf::ObjectId) -> [f32; 4] {
    let media = inherited_box(doc, page, b"MediaBox");
    let crop = inherited_box(doc, page, b"CropBox");
    const LETTER: [f32; 4] = [0.0, 0.0, 612.0, 792.0];
    let intersect = |a: [f32; 4], b: [f32; 4]| -> Option<[f32; 4]> {
        let r = [a[0].max(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].min(b[3])];
        (r[2] > r[0] && r[3] > r[1]).then_some(r)
    };
    match (media, crop) {
        (Some(m), Some(c)) => intersect(m, c).unwrap_or(m),
        (Some(m), None) => m,
        (None, Some(c)) => intersect(LETTER, c).unwrap_or(LETTER),
        (None, None) => LETTER,
    }
}

/// An inheritable box attribute, normalized so `x0 < x1` and `y0 < y1`.
fn inherited_box(doc: &lopdf::Document, page: lopdf::ObjectId, key: &[u8]) -> Option<[f32; 4]> {
    use lopdf::Object;
    let number = |o: &Object| -> Option<f32> {
        let o = match o {
            Object::Reference(r) => doc.get_object(*r).ok()?,
            other => other,
        };
        match o {
            Object::Integer(i) => Some(*i as f32),
            Object::Real(r) => Some(*r),
            _ => None,
        }
    };
    let mut id = page;
    for _ in 0..32 {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(obj) = dict.get(key) {
            let array = match obj {
                Object::Array(a) => Some(a),
                Object::Reference(r) => match doc.get_object(*r) {
                    Ok(Object::Array(a)) => Some(a),
                    _ => None,
                },
                _ => None,
            };
            if let Some(array) = array {
                let v: Vec<f32> = array.iter().filter_map(number).collect();
                if v.len() >= 4 && v[..4].iter().all(|x| x.is_finite()) {
                    let b = [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])];
                    if b[2] > b[0] && b[3] > b[1] {
                        return Some(b);
                    }
                }
            }
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(parent)) => id = *parent,
            _ => return None,
        }
    }
    None
}

/// The origin to add to a position on 1-based `page`; (0, 0) when unknown.
fn origin_of(origins: &[(f32, f32)], page: u32) -> (f32, f32) {
    page.checked_sub(1)
        .and_then(|i| origins.get(i as usize).copied())
        .unwrap_or((0.0, 0.0))
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
    let cached = get_or_load_pdf(path)?;
    let meta = cached.lopdf_meta();
    // Large (>1,000 page) documents skip full-document position caching on open;
    // for those, extract only the requested page from disk.
    if meta.origins.len() > POSITIONS_PAGE_LIMIT {
        let filter = std::collections::HashSet::from([page]);
        let items = pdf_inspector::extractor::extract_text_with_positions_pages(path, Some(&filter))
            .map_err(map_err)?;
        let (dx, dy) = origin_of(&meta.origins, page);
        return Ok(items
            .into_iter()
            .filter(|item| {
                matches!(item.item_type, ItemType::Text)
                    && !item.text.trim().is_empty()
                    && item.width > 0.0
                    && item.height > 0.0
            })
            .map(|item| TextItemRect {
                text: item.text,
                rect: Rect {
                    x: item.x + dx,
                    y: item.y + dy,
                    width: item.width,
                    height: item.height,
                },
            })
            .collect());
    }
    let pos = cached.positions()?;
    Ok(pos.by_page.get(&page).cloned().unwrap_or_default())
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
    let cached = get_or_load_pdf(path)?;
    let bytes = &cached.bytes;
    let bbox = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
    // The region API indexes pages from zero.
    let regions = vec![(page - 1, vec![bbox])];

    let results = extract_text_in_regions_mem(bytes, &regions).map_err(map_err)?;
    let text = results
        .iter()
        .flat_map(|p| p.regions.iter())
        .map(|r| r.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    // A selected table is worth far more as a table than as reflowed prose.
    let table = extract_tables_in_regions_mem(bytes, &regions)
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
        let local = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        if local.exists() {
            return local.to_string_lossy().into_owned();
        }
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/tests/fixtures")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn resource(name: &str) -> String {
        let local = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(name);
        if local.exists() {
            return local.to_string_lossy().into_owned();
        }
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/resources")
            .join(name)
            .to_string_lossy()
            .into_owned()
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

    #[test]
    fn tagged_headings_come_from_the_document_not_from_font_sizes() {
        // A tagged PDF declares its own headings. Before 9.5 the only sources
        // were the author's bookmarks (often absent) and a guess made from
        // markdown produced by font-size heuristics.
        let path = fixture("tagged-headings.pdf");
        let model = open_document(&path).expect("tagged fixture opens");
        let titles: Vec<&str> = model
            .structure_outline
            .iter()
            .map(|h| h.title.as_str())
            .collect();
        assert!(
            titles.contains(&"Chapter One") && titles.contains(&"Chapter Two"),
            "structure outline should carry both H1s, got {titles:?}"
        );
        // The body paragraph is tagged /P, not a heading, and must not appear.
        assert!(
            !titles.iter().any(|t| t.contains("Body text")),
            "a /P element is not a heading: {titles:?}"
        );
        assert_eq!(
            model.structure_outline.iter().map(|h| h.page).collect::<Vec<_>>(),
            vec![1, 2],
            "each heading is anchored to the page it is tagged on"
        );
    }

    #[test]
    fn an_untagged_document_yields_no_structure_outline() {
        // Most PDFs are not tagged. They must fall back exactly as before
        // rather than gain an empty-but-present outline that outranks the
        // synthesized one.
        let model = open_document(&fixture("text-pages.pdf")).expect("opens");
        assert!(model.structure_outline.is_empty());
    }

    #[test]
    fn heading_roles_map_to_the_two_levels_an_outline_keeps() {
        assert_eq!(heading_level("H1"), Some(1));
        assert_eq!(heading_level("H"), Some(1));
        assert_eq!(heading_level("H2"), Some(2));
        // Deeper headings fold rather than vanish: a document tagged only from
        // H3 down would otherwise get no outline at all.
        assert_eq!(heading_level("H4"), Some(2));
        assert_eq!(heading_level("P"), None);
        assert_eq!(heading_level("Table"), None);
        assert_eq!(heading_level("TD"), None);
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
        // The destination is nowhere in the page text — this is the only way a
        // reader of that text learns the link exists, so it must say where.
        assert!(
            doc.links.iter().all(|l| !l.context.is_empty()),
            "every link should be placed in its line",
        );
        assert!(
            doc.links.iter().all(|l| !l.context.contains("http")),
            "context is the sentence, not the URL echoed back",
        );
    }

    fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect { x, y, width, height }
    }

    fn link_at(r: Rect) -> Link {
        Link {
            page: 1,
            url: "https://example.com/".into(),
            context: String::new(),
            rect: r,
        }
    }

    #[test]
    fn places_a_link_on_the_line_it_covers_most() {
        let lines = vec![
            (1, rect(0.0, 100.0, 300.0, 12.0), "the line above".to_string()),
            (1, rect(0.0, 80.0, 300.0, 12.0), "See <u>the spec</u> for details".to_string()),
        ];
        let link = link_at(rect(30.0, 81.0, 40.0, 10.0));
        // Inline markup is stripped: the context reads as a sentence.
        assert_eq!(link_context(&link, &lines), "See the spec for details");
    }

    #[test]
    fn never_borrows_a_line_from_another_page() {
        let lines = vec![(2, rect(0.0, 80.0, 300.0, 12.0), "on page two".to_string())];
        let link = link_at(rect(30.0, 81.0, 40.0, 10.0));
        assert_eq!(link_context(&link, &lines), "");
    }

    #[test]
    fn leaves_context_empty_rather_than_guessing_a_distant_line() {
        // A link box floating clear of every run — a bare annotation over a
        // figure. Naming the nearest line would attribute it to a sentence it
        // has nothing to do with.
        let lines = vec![(1, rect(0.0, 400.0, 300.0, 12.0), "far away".to_string())];
        let link = link_at(rect(30.0, 81.0, 40.0, 10.0));
        assert_eq!(link_context(&link, &lines), "");
    }

    #[test]
    fn truncates_a_context_that_is_really_a_paragraph() {
        let long = "word ".repeat(80);
        let lines = vec![(1, rect(0.0, 80.0, 300.0, 12.0), long)];
        let link = link_at(rect(30.0, 81.0, 40.0, 10.0));
        let context = link_context(&link, &lines);
        assert!(context.ends_with('…'));
        assert_eq!(context.chars().count(), LINK_CONTEXT_MAX_CHARS + 1);
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
    fn recovered_lines_are_put_back_into_paragraphs() {
        let text = "however, it became too conspicuous and dan-\ngerous for use.\nA report creeps into camp that\nJohnston is coming with fifty\nthousand men.\nThe Yankee Lookout.\nJUNE 10TH.—The heat of the sun increases.";
        let out = reflow_lines(text);
        assert!(out.contains("dangerous for use."), "{out}");
        assert!(out.contains("camp that Johnston is coming with fifty thousand men."), "{out}");
        assert!(out.contains("\n\nThe Yankee Lookout.\n\nJUNE 10TH"), "{out}");
        // CJK lines join as they were set; a real hyphen stays.
        assert_eq!(reflow_lines("第一行文字继续\n到第二行"), "第一行文字继续到第二行");
        assert_eq!(reflow_lines("a well-\nKnown name"), "a well- Known name");
        assert_eq!(reflow_lines("the end of it\n[Image: Im001]\n[Image: Im002]"), "the end of it");
    }

    /// pdf-inspector after 1.17 reports positions relative to the visible box;
    /// pdf.js draws them expecting absolute user space. On a page cropped to
    /// `[100 100 512 692]` a relative rect lands 100pt left and 100pt low.
    #[test]
    fn positions_on_a_cropped_page_are_in_absolute_user_space() {
        let items = page_text_items(&fixture("cropped.pdf"), 1).expect("items");
        let marker = items
            .iter()
            .find(|i| i.text.contains("Marker text"))
            .expect("marker run");
        assert!((marker.rect.x - 150.0).abs() < 1.0, "x = {}", marker.rect.x);
        assert!((marker.rect.y - 600.0).abs() < 3.0, "y = {}", marker.rect.y);

        let model = open_document(&fixture("cropped.pdf")).expect("open");
        let link = model.links.first().expect("link");
        assert!((link.rect.x - 150.0).abs() < 1.0, "link x = {}", link.rect.x);
        assert!((link.rect.y - 560.0).abs() < 1.0, "link y = {}", link.rect.y);
        assert!(link.context.contains("A link on a cropped page"), "context = {}", link.context);
    }

    /// The numbers `n` of every "line n" in `text`, which "line 1" alone
    /// would also find inside "line 10".
    fn numbered_lines(text: &str) -> Vec<u32> {
        let mut out: Vec<u32> = text
            .split("line ")
            .skip(1)
            .filter_map(|rest| {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().ok()
            })
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    /// A page turned in a reader and saved keeps its MediaBox and content
    /// and only gains `/Rotate`, so the model must be given every line of it.
    /// The v24 evaluation measured 33 of 40 on such a page; its sample was
    /// ReportLab's shape instead (page 5, below), and with the box left as it
    /// was all 40 come through at every angle. (24.0)
    #[test]
    fn a_rotated_page_gives_the_model_every_line() {
        let path = fixture("rotated.pdf");
        let model = open_document(&path).expect("open");
        let all: Vec<u32> = (0..40).collect();
        let upright = &model.pages[0].text;
        assert_eq!(numbered_lines(upright), all, "/Rotate 0");
        for (index, degrees) in [(1usize, 90), (2, 180), (3, 270)] {
            let page = &model.pages[index];
            assert!(!page.needs_vision, "/Rotate {degrees} sent to vision");
            assert_eq!(numbered_lines(&page.text), all, "/Rotate {degrees}");
            // Same lines as the upright page, word for word: turning a page
            // changes how it is drawn, never what it says.
            let n = page.page;
            let expected = upright
                .replace("Page 1 ", &format!("Page {n} "))
                .replace("revenue of 7 ", &format!("revenue of {} ", n * 7));
            assert_eq!(page.text, expected, "/Rotate {degrees}");
            let items = page_text_items(&path, n).expect("items");
            let runs: String = items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>().join("\n");
            assert_eq!(numbered_lines(&runs), all, "/Rotate {degrees} runs");
        }
    }

    /// ReportLab's `setPageRotation(90)` swaps the MediaBox to `[0 0 792 612]`
    /// while portrait content is still drawn up to y = 720, which is what the
    /// evaluation's `rot90.pdf` was. Lines 0-6 lie above the box and no
    /// renderer draws them, so they are not the reader's page; whatever
    /// pdf-inspector decides about them, every line inside the box must reach
    /// the model. (24.0)
    #[test]
    fn a_page_drawn_past_its_mediabox_keeps_everything_inside_the_box() {
        let model = open_document(&fixture("rotated.pdf")).expect("open");
        let lines = numbered_lines(&model.pages[4].text);
        assert!((7..40).all(|l| lines.contains(&l)), "lines = {lines:?}");
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
        // Coded (24.0), so the front end can say "damaged" and what to do.
        let err = open_document(&fixture("damaged.pdf")).unwrap_err();
        assert!(err.starts_with(doc_check::PDF_DAMAGED), "{err}");
    }

    #[test]
    fn a_password_protected_pdf_says_so() {
        let err = open_document(&fixture("encrypted.pdf")).unwrap_err();
        assert!(err.starts_with(doc_check::PDF_ENCRYPTED), "{err}");
    }

    #[test]
    fn an_owner_only_protected_pdf_still_opens() {
        // Restrictions without a user password: the empty password opens it,
        // so it must not be reported as needing one.
        let doc = open_document(&fixture("encrypted-owner-only.pdf")).expect("opens");
        assert!(doc.page_count >= 1);
    }

    #[test]
    fn sample_pdf_extracts_internal_goto_link_table_and_strips_page_footers() {
        let doc = open_document(&resource("sample.pdf")).expect("sample opens");
        assert_eq!(doc.page_count, 2);
        assert!(doc.pages[0].has_table, "expected pricing table on page 1");
        assert!(
            doc.links.iter().any(|l| l.page == 1 && l.url == "pagewise-goto:2"),
            "expected internal link to page 2, got {:?}",
            doc.links
        );
        assert!(!doc.pages[0].text.ends_with("1 / 2"), "running footer should be stripped");
        assert!(!doc.pages[1].text.ends_with("2 / 2"), "running footer should be stripped");
    }

    #[test]
    fn strips_numbered_running_footers_while_keeping_numbered_lists() {
        let mut pages = pages_of(&[
            "1. Scope of work\nbody one\nPage 1 of 3",
            "1. Scope of work\nbody two\nPage 2 of 3",
            "2. Payment terms\nbody three\nPage 3 of 3",
        ]);
        strip_running_lines(&mut pages);
        assert!(pages[0].starts_with("1. Scope of work"));
        assert!(pages.iter().all(|p| !p.contains("of 3")));
    }
}
