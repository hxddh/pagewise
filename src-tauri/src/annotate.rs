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

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use serde::Deserialize;

use crate::doc_check;
use crate::inspect::{inherited_rotation, visible_box, Rect};

/// Prefix of the `/NM` of every annotation PageWise writes.
const NM_PREFIX: &str = "pagewise-";
/// More than any reader will make; bounds a malicious or runaway request.
const MAX_ANNOTATIONS: usize = 5_000;
const MAX_RECTS: usize = 256;
const MAX_CONTENTS: usize = 8_000;
/// How far below a run's baseline its highlight reaches, as a share of its height.
/// `0.29` covers lowered inline subscript baselines (`r₁…rₙ`, `medianₖ₍ₒ₎`)
/// without encroaching on tight single-spaced lines below (28.0).
const DESCENT: f32 = 0.29;

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
///
/// Note on rotation: `clientRectToPageRect` already maps screen coordinates
/// through pdf.js's `toPdfPoint` and stores an unrotated, crop-relative
/// top-left rectangle (`Frame::View`), so converting `Frame::View` back to PDF
/// user space only translates from the visible box's top-left without rotating
/// a second time.
fn absolute(r: &Rect, frame: Frame, kind: Kind, view: [f32; 4], rotation: u16) -> Option<[f32; 4]> {
    if ![r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite()) || r.width <= 0.0 || r.height <= 0.0 {
        return None;
    }
    Some(match frame {
        Frame::Pdf if kind == Kind::Square => [r.x, r.y, r.x + r.width, r.y + r.height],
        Frame::Pdf => {
            // Extend baseline descent strictly perpendicular to the glyph run's
            // actual baseline axis (30.0). On a portrait-stream page saved with
            // `/Rotate 90` or `/Rotate 270` (`rotated.pdf`), lines still run
            // horizontally in user space (`r.width >> r.height`), so scaling
            // `r.width` by `DESCENT` previously overshot +84pt into the margin.
            let horizontal_stream_on_turned_page = r.width > r.height * 2.0 && r.width > 24.0;
            let vertical_stream_on_upright_page = r.height > r.width * 4.5 && r.height > 28.0;
            match rotation % 360 {
                90 if !horizontal_stream_on_turned_page => {
                    [r.x, r.y, r.x + r.width * (1.0 + DESCENT), r.y + r.height]
                }
                270 if !horizontal_stream_on_turned_page => {
                    [r.x - DESCENT * r.width, r.y, r.x + r.width, r.y + r.height]
                }
                180 if !vertical_stream_on_upright_page => {
                    [r.x, r.y, r.x + r.width, r.y + r.height * (1.0 + DESCENT)]
                }
                0 | 180 if vertical_stream_on_upright_page => {
                    [r.x, r.y, r.x + r.width * (1.0 + DESCENT), r.y + r.height]
                }
                _ => [r.x, r.y - DESCENT * r.height, r.x + r.width, r.y + r.height],
            }
        }
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

/// QuadPoints ordered `[UL, UR, LL, LR]` along the page's displayed orientation
/// (ISO 32000-1 §12.5.6.10) so rotated pages draw natural highlight caps while
/// preserving the exact `[x0, y0, x1, y1]` axis-aligned envelope.
fn quad_for_rect(r: [f32; 4], rotation: u16) -> [f32; 8] {
    match rotation % 360 {
        90 => [r[0], r[1], r[0], r[3], r[2], r[1], r[2], r[3]],
        180 => [r[2], r[1], r[0], r[1], r[2], r[3], r[0], r[3]],
        270 => [r[2], r[3], r[2], r[1], r[0], r[3], r[0], r[1]],
        _ => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]],
    }
}

/// Build an explicit `/AP << /N <Form XObject> >>` stream so PDF viewers that
/// do not synthesize annotation appearances (QuickLook, lightweight Linux
/// viewers, print pipelines) still render crisp multiply-blended highlights and
/// stroked region boxes.
fn build_appearance_stream(
    doc: &mut Document,
    kind: Kind,
    bounds: [f32; 4],
    rects: &[[f32; 4]],
    rgb: [f32; 3],
) -> ObjectId {
    let w = (bounds[2] - bounds[0]).max(0.01);
    let h = (bounds[3] - bounds[1]).max(0.01);
    let [cr, cg, cb] = [
        rgb[0].clamp(0.0, 1.0),
        rgb[1].clamp(0.0, 1.0),
        rgb[2].clamp(0.0, 1.0),
    ];
    let mut ops = String::new();
    let resources = match kind {
        Kind::Highlight => {
            ops.push_str(&format!("q /GS0 gs {cr:.4} {cg:.4} {cb:.4} rg "));
            for r in rects {
                let x = r[0] - bounds[0];
                let y = r[1] - bounds[1];
                let rw = (r[2] - r[0]).max(0.01);
                let rh = (r[3] - r[1]).max(0.01);
                ops.push_str(&format!("{x:.3} {y:.3} {rw:.3} {rh:.3} re "));
            }
            ops.push_str("f Q");
            let gs = dictionary! {
                "Type" => "ExtGState",
                "BM" => "Multiply",
                "ca" => Object::Real(0.45),
                "CA" => Object::Real(0.45),
            };
            dictionary! {
                "ExtGState" => dictionary! { "GS0" => gs },
            }
        }
        Kind::Square => {
            ops.push_str(&format!("q 1.5 w {cr:.4} {cg:.4} {cb:.4} RG "));
            for r in rects {
                let x = (r[0] - bounds[0]) + 0.75;
                let y = (r[1] - bounds[1]) + 0.75;
                let rw = (r[2] - r[0] - 1.5).max(0.01);
                let rh = (r[3] - r[1] - 1.5).max(0.01);
                ops.push_str(&format!("{x:.3} {y:.3} {rw:.3} {rh:.3} re S "));
            }
            ops.push('Q');
            dictionary! {}
        }
    };
    let form_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "FormType" => 1,
        "BBox" => vec![
            Object::Real(0.0),
            Object::Real(0.0),
            Object::Real(w),
            Object::Real(h),
        ],
        "Resources" => resources,
    };
    doc.add_object(Stream::new(form_dict, ops.into_bytes()))
}

fn delete_annot_tree(doc: &mut Document, annot: &Object) {
    let Object::Reference(annot_id) = annot else {
        return;
    };
    let mut ap_refs = Vec::new();
    if let Ok(dict) = doc.get_dictionary(*annot_id) {
        if let Ok(ap_obj) = dict.get(b"AP") {
            let ap_dict = match ap_obj {
                Object::Reference(id) => {
                    ap_refs.push(*id);
                    doc.get_dictionary(*id).ok()
                }
                Object::Dictionary(d) => Some(d),
                _ => None,
            };
            if let Some(d) = ap_dict {
                for (_, v) in d.iter() {
                    if let Object::Reference(stream_id) = v {
                        ap_refs.push(*stream_id);
                    }
                }
            }
        }
    }
    for id in ap_refs {
        doc.delete_object(id);
    }
    doc.delete_object(*annot_id);
}

/// Annotate `doc` in memory; returns how many annotations were written.
pub fn annotate_document(doc: &mut Document, annotations: &[AnnotationIn], now: u64) -> Result<usize, String> {
    if annotations.len() > MAX_ANNOTATIONS {
        return Err("Too many annotations".into());
    }
    let pages: BTreeMap<u32, ObjectId> = doc.get_pages();
    let date = pdf_date(now);

    // What PageWise wrote last time goes first, on every page — including its
    // indirect annotation and `/AP` stream objects so re-exports never bloat.
    for &page in pages.values() {
        let before = annots_of(doc, page);
        if before.is_empty() {
            continue;
        }
        let mut kept = Vec::with_capacity(before.len());
        let mut removed = Vec::new();
        for a in before {
            if name_of(doc, &a).is_some_and(|n| n.starts_with(NM_PREFIX.as_bytes())) {
                removed.push(a);
            } else {
                kept.push(a);
            }
        }
        if !removed.is_empty() {
            set_annots(doc, page, kept)?;
            for old in &removed {
                delete_annot_tree(doc, old);
            }
        }
    }

    let mut written = 0;
    let mut by_page: BTreeMap<ObjectId, Vec<Object>> = BTreeMap::new();
    for a in annotations {
        let Some(&page) = pages.get(&a.page) else { continue };
        let view = visible_box(doc, page);
        let rotation = inherited_rotation(doc, page);
        let rects: Vec<[f32; 4]> = a
            .rects
            .iter()
            .take(MAX_RECTS)
            .filter_map(|r| absolute(r, a.frame, a.kind, view, rotation))
            .collect();
        if rects.is_empty() {
            continue;
        }
        let bounds = rects.iter().fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |b, r| {
            [b[0].min(r[0]), b[1].min(r[1]), b[2].max(r[2]), b[3].max(r[3])]
        });
        let quads: Vec<Object> = rects
            .iter()
            .flat_map(|r| quad_for_rect(*r, rotation))
            .map(Object::Real)
            .collect();
        let ap_stream = build_appearance_stream(doc, a.kind, bounds, &rects, a.color);
        let color: Vec<Object> = a.color.iter().map(|c| Object::Real(c.clamp(0.0, 1.0))).collect();
        let contents: String = a.contents.chars().take(MAX_CONTENTS).collect();
        let id: String = a.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
        let mut dict: Dictionary = dictionary! {
            "Type" => "Annot",
            "Rect" => bounds.iter().map(|v| Object::Real(*v)).collect::<Vec<_>>(),
            "C" => color,
            "F" => 4,
            "P" => page,
            "AP" => dictionary! { "N" => ap_stream },
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

fn ensure_decrypted(doc: &mut Document, password: Option<&str>) -> Result<(), String> {
    if doc.is_encrypted() {
        let _ = doc.decrypt("");
    }
    if doc.is_encrypted() {
        if let Some(pw) = password {
            let _ = doc.decrypt(pw);
        }
    }
    if doc.is_encrypted() {
        return Err(doc_check::coded(
            doc_check::PDF_ENCRYPTED,
            "PDF requires a password",
        ));
    }
    Ok(())
}

/// Annotate a PDF byte buffer in memory, returning `(pdf_bytes, count_written)`.
#[allow(dead_code)]
pub fn annotate_bytes(bytes: &[u8], annotations: &[AnnotationIn]) -> Result<(Vec<u8>, usize), String> {
    annotate_bytes_with_password(bytes, annotations, None)
}

fn load_annotated_doc(
    bytes: &[u8],
    annotations: &[AnnotationIn],
    password: Option<&str>,
) -> Result<(Document, usize), String> {
    let pw_str = password.unwrap_or("").to_string();
    let mut doc = Document::load_mem_with_options(
        bytes,
        lopdf::LoadOptions {
            password: Some(pw_str),
            ..Default::default()
        },
    )
    .or_else(|_| Document::load_mem(bytes))
    .map_err(|e| {
        if bytes.windows(8).any(|w| w == b"/Encrypt") {
            doc_check::coded(doc_check::PDF_ENCRYPTED, "PDF requires a password")
        } else {
            format!("Failed to read PDF: {e}")
        }
    })?;
    ensure_decrypted(&mut doc, password)?;
    doc.trailer.remove(b"Encrypt");
    doc.encryption_state = None;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let written = annotate_document(&mut doc, annotations, now)?;
    Ok((doc, written))
}

pub fn annotate_bytes_with_password(
    bytes: &[u8],
    annotations: &[AnnotationIn],
    password: Option<&str>,
) -> Result<(Vec<u8>, usize), String> {
    let (mut doc, written) = load_annotated_doc(bytes, annotations, password)?;
    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| format!("Failed to write PDF: {e}"))?;
    Ok((out, written))
}

/// Load `src`, annotate it, and save the result to `out`.
#[allow(dead_code)]
pub fn annotate_file(src: &Path, out: &Path, annotations: &[AnnotationIn]) -> Result<usize, String> {
    annotate_file_checked(src, out, annotations, None)
}

/// Stamp-locked variant of [`annotate_file`]: when `expected_stamp` is supplied,
/// reads from the matching in-memory snapshot (preventing split-brain coordinate
/// drift if `src` changed on disk) and streams `save_to` directly through a
/// `BufWriter` without buffering an extra whole-PDF `Vec<u8>` in RAM (30.0).
pub fn annotate_file_checked(
    src: &Path,
    out: &Path,
    annotations: &[AnnotationIn],
    expected_stamp: Option<&str>,
) -> Result<usize, String> {
    use std::io::{BufWriter, Write};
    let pw = doc_check::session_password(src);
    let src_arc = crate::inspect::cached_pdf_for_stamp(src, expected_stamp)?;
    let (mut doc, written) = load_annotated_doc(src_arc.as_slice(), annotations, pw.as_deref())?;
    drop(src_arc);

    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let parent = out.parent().unwrap_or_else(|| Path::new("."));
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = parent.join(format!(".pagewise-{}-{}.tmp", std::process::id(), (1u64 << 40) + seq));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("Failed to write PDF: {e}"))?;
    let commit = (|| -> std::io::Result<()> {
        let saved = (|| -> std::io::Result<()> {
            let mut writer = BufWriter::new(file);
            doc.save_to(&mut writer)
                .map_err(std::io::Error::other)?;
            writer.flush()?;
            let inner = writer.into_inner().map_err(|e| e.into_error())?;
            inner.sync_all()
        })();
        saved?;
        let mut attempt = 0u32;
        loop {
            match std::fs::rename(&tmp, out) {
                Ok(()) => break,
                Err(e)
                    if cfg!(windows)
                        && e.kind() == std::io::ErrorKind::PermissionDenied
                        && attempt < 4 =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5 << attempt));
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        }
        if let Some(dir) = out.parent().and_then(|p| std::fs::File::open(p).ok()) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    commit.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to write PDF: {e}")
    })?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let local = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        if local.exists() {
            return local;
        }
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/tests/fixtures")
            .join(name)
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
        // Reaching 0.29 of the line below the baseline, for descenders & subscripts.
        assert_eq!(reals(a.get(b"QuadPoints").unwrap()), vec![72.0, 652.0, 402.0, 652.0, 72.0, 636.52, 402.0, 636.52]);
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

    #[test]
    fn a_file_named_like_the_old_temp_is_left_alone() {
        // 21.1.1 and before saved through `<out>.pdf.partial` with
        // `File::create`: a reader's file of that name was truncated and
        // renamed away (21.1.2).
        let dir = std::env::temp_dir().join(format!("pagewise-annotate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let theirs = dir.join("out.pdf.partial");
        std::fs::write(&theirs, b"the reader's own file").unwrap();
        let out = dir.join("out.pdf");
        annotate_file(&fixture("text-pages.pdf"), &out, &[]).expect("annotate");
        assert_eq!(std::fs::read(&theirs).unwrap(), b"the reader's own file");
        assert!(std::fs::read(&out).unwrap().starts_with(b"%PDF"));
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn owner_only_encrypted_pdf_can_be_annotated_while_user_encrypted_is_refused() {
        let owner_bytes = std::fs::read(fixture("encrypted-owner-only.pdf")).unwrap();
        let r = Rect { x: 72.0, y: 640.0, width: 120.0, height: 12.0 };
        let (out, n) = annotate_bytes(&owner_bytes, &[annot("own", 1, Frame::Pdf, r, "verified")]).unwrap();
        assert_eq!(n, 1);
        let reopened = Document::load_mem(&out).unwrap();
        assert_eq!(page_annots(&reopened, 1).len(), 1);

        let user_bytes = std::fs::read(fixture("encrypted.pdf")).unwrap();
        let err = annotate_bytes(&user_bytes, &[annot("enc", 1, Frame::Pdf, r, "x")]).unwrap_err();
        assert!(err.starts_with(doc_check::PDF_ENCRYPTED), "{err}");

        // Session-unlocked user-encrypted PDF exports a clean, unencrypted annotated copy.
        let (unlocked_out, unlocked_n) = annotate_bytes_with_password(
            &user_bytes,
            &[annot("enc-ok", 1, Frame::Pdf, r, "unlocked note")],
            Some("secret"),
        )
        .expect("session password unlocks and exports");
        assert_eq!(unlocked_n, 1);
        let unlocked_reopened = Document::load_mem(&unlocked_out).expect("reopens without password");
        assert!(!unlocked_reopened.is_encrypted());
        assert_eq!(page_annots(&unlocked_reopened, 1).len(), 1);
    }

    #[test]
    fn view_frame_marks_do_not_double_rotate() {
        let view = [100.0, 100.0, 512.0, 692.0];
        let r = Rect { x: 10.0, y: 20.0, width: 50.0, height: 12.0 };
        assert_eq!(
            absolute(&r, Frame::View, Kind::Square, view, 0),
            Some([110.0, 660.0, 160.0, 672.0])
        );
    }

    #[test]
    fn pdf_highlights_extend_descent_for_short_words_and_rotated_pages() {
        let view = [0.0, 0.0, 612.0, 792.0];
        // Short 2-letter word ("of"): width < height still gets full baseline descent.
        let short = Rect { x: 100.0, y: 500.0, width: 8.0, height: 10.0 };
        assert_eq!(
            absolute(&short, Frame::Pdf, Kind::Highlight, view, 0),
            Some([100.0, 500.0 - 10.0 * DESCENT, 108.0, 510.0])
        );
        // Rotated /Rotate 90 and /Rotate 270 extend along the baseline's perpendicular X axis.
        let rot = Rect { x: 200.0, y: 300.0, width: 10.0, height: 40.0 };
        assert_eq!(
            absolute(&rot, Frame::Pdf, Kind::Highlight, view, 90),
            Some([200.0, 300.0, 200.0 + 10.0 * (1.0 + DESCENT), 340.0])
        );
        assert_eq!(
            absolute(&rot, Frame::Pdf, Kind::Highlight, view, 270),
            Some([200.0 - 10.0 * DESCENT, 300.0, 210.0, 340.0])
        );
        // Portrait-stream page turned via `/Rotate 90` or `/Rotate 270` (`rotated.pdf`):
        // horizontal lines (`width: 290, height: 11`) must extend descent along Y, NOT +84pt along X!
        let portrait_line = Rect { x: 72.0, y: 720.0, width: 290.0, height: 11.0 };
        assert_eq!(
            absolute(&portrait_line, Frame::Pdf, Kind::Highlight, view, 90),
            Some([72.0, 720.0 - 11.0 * DESCENT, 362.0, 731.0])
        );
        assert_eq!(
            absolute(&portrait_line, Frame::Pdf, Kind::Highlight, view, 270),
            Some([72.0, 720.0 - 11.0 * DESCENT, 362.0, 731.0])
        );
    }

    #[test]
    fn writes_ap_appearance_and_deletes_orphan_objects_on_re_export() {
        let mut doc = Document::load(fixture("text-pages.pdf")).unwrap();
        let r = Rect { x: 72.0, y: 640.0, width: 120.0, height: 12.0 };
        annotate_document(&mut doc, &[annot("ap1", 1, Frame::Pdf, r, "first")], 0).unwrap();
        let count_after_first = doc.objects.len();
        let first_annot = &page_annots(&doc, 1)[0];
        let ap = first_annot.get(b"AP").unwrap().as_dict().unwrap();
        let ap_ref = ap.get(b"N").unwrap().as_reference().unwrap();
        assert!(doc.get_object(ap_ref).is_ok());

        // Re-exporting 1 annotation replaces both the Annot dict and its /AP stream
        // without accumulating dead objects in `doc.objects`.
        annotate_document(&mut doc, &[annot("ap1", 1, Frame::Pdf, r, "second")], 0).unwrap();
        assert!(doc.get_object(ap_ref).is_err(), "old /AP stream should be deleted");
        assert_eq!(doc.objects.len(), count_after_first, "object count should stay flat on re-export");
    }
}
