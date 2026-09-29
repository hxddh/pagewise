//! Write the reader's evidence back into the PDF (14.1).
//!
//! What PageWise found and what the reader marked lives in PageWise. Someone
//! who does not use it — a colleague, a counterparty, a court — sees none of
//! it. This writes each located finding and each mark as a standard PDF
//! Highlight annotation, with the note or claim as its contents, into a copy
//! of the document. Any PDF reader shows them; PageWise's own annotation
//! reader reads them back, which is how the evaluation checks the round trip.
//!
//! Written as a new file, never over the source: a full rewrite (which is what
//! lopdf does) invalidates a digital signature, and the reader should keep the
//! file they were given.
//!
//! Re-exporting a file PageWise already annotated replaces its previous
//! annotations instead of stacking a second copy: each carries an `/NM`
//! starting `pagewise-`, and those are removed first. Annotations anyone else
//! wrote are left alone.

use std::collections::BTreeMap;
use std::path::Path;

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, StringFormat};
use serde::Deserialize;

use crate::inspect::{visible_box, Rect};

/// Prefix of the `/NM` of every annotation PageWise writes.
const NM_PREFIX: &str = "pagewise-";
/// More than any reader will make; bounds a malicious or runaway request.
const MAX_ANNOTATIONS: usize = 5_000;
const MAX_RECTS: usize = 256;
const MAX_CONTENTS: usize = 8_000;
/// How far below a run's baseline its highlight reaches, as a share of its height.
const DESCENT: f32 = 0.25;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Frame {
    /// Absolute user space, bottom-left origin: text runs, located quotes.
    Pdf,
    /// Offset from the visible box, top-left origin: marks, as stored.
    View,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// A wash over words.
    #[default]
    Highlight,
    /// An outline around a region: a wash over a figure hides the figure.
    Square,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationIn {
    #[serde(default)]
    pub kind: Kind,
    /// Stable id, so a re-export can be told from a new annotation.
    pub id: String,
    /// 1-based.
    pub page: u32,
    pub rects: Vec<Rect>,
    pub frame: Frame,
    pub contents: String,
    pub author: String,
    pub subject: String,
    /// RGB, 0–1.
    pub color: [f32; 3],
}

/// A rect in absolute user space, as `[x0, y0, x1, y1]`.
fn absolute(r: &Rect, frame: Frame, view: [f32; 4]) -> Option<[f32; 4]> {
    if ![r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite()) || r.width <= 0.0 || r.height <= 0.0 {
        return None;
    }
    Some(match frame {
        // A text run's rect starts at the baseline. A highlight must cover the
        // descenders too, as any reader's own highlights do — and pdf.js places
        // a glyph for "what text is under this highlight" at a point that can
        // sit just under the baseline, so a quad starting exactly on it reads
        // back as covering nothing (measured in `eval/annotate.eval.ts`).
        Frame::Pdf => [r.x, r.y - DESCENT * r.height, r.x + r.width, r.y + r.height],
        Frame::View => {
            let x0 = view[0] + r.x;
            let top = view[3] - r.y;
            [x0, top - r.height, x0 + r.width, top]
        }
    })
}

/// A PDF text string: PDFDocEncoding is ASCII-compatible, anything else goes
/// as UTF-16BE with a byte-order mark, which every reader understands.
fn text_string(s: &str) -> Object {
    if s.is_ascii() {
        return Object::String(s.as_bytes().to_vec(), StringFormat::Literal);
    }
    let mut bytes = vec![0xFE, 0xFF];
    for unit in s.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

/// `D:YYYYMMDDHHmmSSZ`, from the system clock, without a date library.
fn pdf_date(unix: u64) -> String {
    let days = (unix / 86_400) as i64;
    let secs = unix % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "D:{y:04}{m:02}{d:02}{:02}{:02}{:02}Z",
        secs / 3_600,
        (secs % 3_600) / 60,
        secs % 60
    )
}

fn name_of(doc: &Document, annot: &Object) -> Option<Vec<u8>> {
    let dict = match annot {
        Object::Reference(r) => doc.get_dictionary(*r).ok()?,
        Object::Dictionary(d) => d,
        _ => return None,
    };
    match dict.get(b"NM").ok()? {
        Object::String(bytes, _) => Some(bytes.clone()),
        _ => None,
    }
}

/// The page's `/Annots` entries, resolved to an owned list.
fn annots_of(doc: &Document, page: ObjectId) -> Vec<Object> {
    let Ok(dict) = doc.get_dictionary(page) else { return vec![] };
    match dict.get(b"Annots") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(r)) => match doc.get_object(*r) {
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![],
        },
        _ => vec![],
    }
}

fn set_annots(doc: &mut Document, page: ObjectId, annots: Vec<Object>) -> Result<(), String> {
    let dict = doc
        .get_object_mut(page)
        .and_then(Object::as_dict_mut)
        .map_err(|e| format!("Page object unreadable: {e}"))?;
    if annots.is_empty() {
        dict.remove(b"Annots");
    } else {
        dict.set("Annots", Object::Array(annots));
    }
    Ok(())
}

/// Annotate `doc` in memory; returns how many annotations were written.
pub fn annotate_document(doc: &mut Document, annotations: &[AnnotationIn], now: u64) -> Result<usize, String> {
    if annotations.len() > MAX_ANNOTATIONS {
        return Err("Too many annotations".into());
    }
    let pages: BTreeMap<u32, ObjectId> = doc.get_pages();
    let date = pdf_date(now);

    // What PageWise wrote last time goes first, on every page.
    for &page in pages.values() {
        let before = annots_of(doc, page);
        if before.is_empty() {
            continue;
        }
        let kept: Vec<Object> = before
            .iter()
            .filter(|a| !name_of(doc, a).is_some_and(|n| n.starts_with(NM_PREFIX.as_bytes())))
            .cloned()
            .collect();
        if kept.len() != before.len() {
            set_annots(doc, page, kept)?;
        }
    }

    let mut written = 0;
    let mut by_page: BTreeMap<ObjectId, Vec<Object>> = BTreeMap::new();
    for a in annotations {
        let Some(&page) = pages.get(&a.page) else { continue };
        let view = visible_box(doc, page);
        let rects: Vec<[f32; 4]> = a
            .rects
            .iter()
            .take(MAX_RECTS)
            .filter_map(|r| absolute(r, a.frame, view))
            .collect();
        if rects.is_empty() {
            continue;
        }
        let bounds = rects.iter().fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |b, r| {
            [b[0].min(r[0]), b[1].min(r[1]), b[2].max(r[2]), b[3].max(r[3])]
        });
        // Upper-left, upper-right, lower-left, lower-right: the order Acrobat
        // writes and every reader draws correctly.
        let quads: Vec<Object> = rects
            .iter()
            .flat_map(|r| [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]])
            .map(Object::Real)
            .collect();
        let color: Vec<Object> = a.color.iter().map(|c| Object::Real(c.clamp(0.0, 1.0))).collect();
        let contents: String = a.contents.chars().take(MAX_CONTENTS).collect();
        let id: String = a.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
        let mut dict: Dictionary = dictionary! {
            "Type" => "Annot",
            "Rect" => bounds.iter().map(|v| Object::Real(*v)).collect::<Vec<_>>(),
            "C" => color,
            "F" => 4,
            "P" => page,
            "NM" => text_string(&format!("{NM_PREFIX}{id}")),
            "T" => text_string(&a.author),
            "Subj" => text_string(&a.subject),
            "Contents" => text_string(&contents),
            "M" => text_string(&date),
            "CreationDate" => text_string(&date),
        };
        match a.kind {
            Kind::Highlight => {
                dict.set("Subtype", Object::Name(b"Highlight".to_vec()));
                dict.set("QuadPoints", quads);
                dict.set("CA", Object::Real(0.45));
            }
            Kind::Square => {
                dict.set("Subtype", Object::Name(b"Square".to_vec()));
                dict.set("BS", dictionary! { "W" => Object::Real(1.5) });
            }
        }
        let annot = doc.add_object(dict);
        by_page.entry(page).or_default().push(Object::Reference(annot));
        written += 1;
    }

    for (page, added) in by_page {
        let mut annots = annots_of(doc, page);
        annots.extend(added);
        set_annots(doc, page, annots)?;
    }
    Ok(written)
}

/// Load `src`, annotate it, and save the result to `out`.
pub fn annotate_file(src: &Path, out: &Path, annotations: &[AnnotationIn]) -> Result<usize, String> {
    let mut doc = Document::load(src).map_err(|e| format!("Failed to read PDF: {e}"))?;
    if doc.is_encrypted() {
        return Err("Encrypted PDFs cannot be annotated".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let written = annotate_document(&mut doc, annotations, now)?;
    // Written beside the target and renamed over it, so a failure midway never
    // leaves half a PDF where the reader asked for one.
    let tmp = out.with_extension("pdf.partial");
    doc.save(&tmp).map_err(|e| format!("Failed to write PDF: {e}"))?;
    std::fs::rename(&tmp, out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to write PDF: {e}")
    })?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    fn annot(id: &str, page: u32, frame: Frame, rect: Rect, contents: &str) -> AnnotationIn {
        AnnotationIn {
            kind: Kind::Highlight,
            id: id.into(),
            page,
            rects: vec![rect],
            frame,
            contents: contents.into(),
            author: "PageWise".into(),
            subject: "Finding".into(),
            color: [0.55, 0.36, 0.96],
        }
    }

    fn page_annots(doc: &Document, page: u32) -> Vec<Dictionary> {
        let id = doc.get_pages()[&page];
        annots_of(doc, id)
            .iter()
            .filter_map(|a| match a {
                Object::Reference(r) => doc.get_dictionary(*r).ok().cloned(),
                Object::Dictionary(d) => Some(d.clone()),
                _ => None,
            })
            .collect()
    }

    fn reals(o: &Object) -> Vec<f32> {
        o.as_array().unwrap().iter().map(|v| v.as_float().unwrap()).collect()
    }

    #[test]
    fn writes_a_highlight_with_quad_points_and_contents() {
        let mut doc = Document::load(fixture("text-pages.pdf")).unwrap();
        let r = Rect { x: 72.0, y: 640.0, width: 330.0, height: 12.0 };
        let n = annotate_document(&mut doc, &[annot("a1", 2, Frame::Pdf, r, "负责：乙方")], 0).unwrap();
        assert_eq!(n, 1);
        let annots = page_annots(&doc, 2);
        assert_eq!(annots.len(), 1);
        let a = &annots[0];
        assert_eq!(a.get(b"Subtype").unwrap().as_name().unwrap(), b"Highlight");
        // Reaching a quarter of the line below the baseline, for descenders.
        assert_eq!(reals(a.get(b"QuadPoints").unwrap()), vec![72.0, 652.0, 402.0, 652.0, 72.0, 637.0, 402.0, 637.0]);
        // Non-ASCII contents travel as UTF-16BE with a byte-order mark.
        let Object::String(bytes, _) = a.get(b"Contents").unwrap() else { panic!() };
        assert_eq!(&bytes[..2], &[0xFE, 0xFF]);
        assert!(page_annots(&doc, 1).is_empty());
    }

    #[test]
    fn places_a_view_frame_mark_from_the_visible_box() {
        // CropBox [100 100 512 692]: a mark 10pt in from the visible top-left.
        let mut doc = Document::load(fixture("cropped.pdf")).unwrap();
        let r = Rect { x: 10.0, y: 10.0, width: 50.0, height: 12.0 };
        annotate_document(&mut doc, &[annot("m1", 1, Frame::View, r, "note")], 0).unwrap();
        // The fixture carries a link of its own; this is the one just written.
        let annots = page_annots(&doc, 1);
        let a = annots
            .iter()
            .find(|a| a.get(b"Subtype").unwrap().as_name().unwrap() == b"Highlight")
            .unwrap();
        assert_eq!(reals(a.get(b"Rect").unwrap()), vec![110.0, 670.0, 160.0, 682.0]);
    }

    #[test]
    fn re_export_replaces_its_own_annotations_and_keeps_others() {
        let mut doc = Document::load(fixture("text-pages.pdf")).unwrap();
        let page = doc.get_pages()[&1];
        // Someone else's note, already in the file.
        let foreign = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Contents" => Object::string_literal("theirs"),
        });
        set_annots(&mut doc, page, vec![Object::Reference(foreign)]).unwrap();
        let r = Rect { x: 72.0, y: 660.0, width: 100.0, height: 12.0 };
        annotate_document(&mut doc, &[annot("a", 1, Frame::Pdf, r, "one")], 0).unwrap();
        annotate_document(&mut doc, &[annot("a", 1, Frame::Pdf, r, "two"), annot("b", 1, Frame::Pdf, r, "three")], 0).unwrap();
        let annots = page_annots(&doc, 1);
        assert_eq!(annots.len(), 3, "their note, and this export's two");
        let subtypes: Vec<_> = annots.iter().map(|a| a.get(b"Subtype").unwrap().as_name().unwrap().to_vec()).collect();
        assert_eq!(subtypes.iter().filter(|s| s.as_slice() == b"Highlight").count(), 2);
    }

    #[test]
    fn skips_what_cannot_be_placed() {
        let mut doc = Document::load(fixture("text-pages.pdf")).unwrap();
        let bad = Rect { x: f32::NAN, y: 0.0, width: 1.0, height: 1.0 };
        let good = Rect { x: 72.0, y: 660.0, width: 100.0, height: 12.0 };
        let n = annotate_document(
            &mut doc,
            &[annot("x", 1, Frame::Pdf, bad, ""), annot("y", 99, Frame::Pdf, good, "")],
            0,
        )
        .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn round_trips_through_a_saved_file() {
        let out = std::env::temp_dir().join(format!("pagewise-annotate-{}.pdf", std::process::id()));
        let r = Rect { x: 72.0, y: 640.0, width: 330.0, height: 12.0 };
        let n = annotate_file(&fixture("text-pages.pdf"), &out, &[annot("rt", 3, Frame::Pdf, r, "claim")]).unwrap();
        assert_eq!(n, 1);
        let back = Document::load(&out).unwrap();
        assert_eq!(page_annots(&back, 3).len(), 1);
        std::fs::remove_file(out).unwrap();
    }

    #[test]
    fn a_region_is_outlined_not_washed() {
        let mut doc = Document::load(fixture("text-pages.pdf")).unwrap();
        let mut a = annot("r", 1, Frame::Pdf, Rect { x: 72.0, y: 400.0, width: 200.0, height: 100.0 }, "figure");
        a.kind = Kind::Square;
        annotate_document(&mut doc, &[a], 0).unwrap();
        let d = &page_annots(&doc, 1)[0];
        assert_eq!(d.get(b"Subtype").unwrap().as_name().unwrap(), b"Square");
        assert!(d.get(b"QuadPoints").is_err());
    }

    #[test]
    fn dates_are_pdf_dates() {
        assert_eq!(pdf_date(0), "D:19700101000000Z");
        assert_eq!(pdf_date(1_790_000_000), "D:20260921141320Z");
        assert_eq!(pdf_date(951_782_400), "D:20000229000000Z");
    }
}
