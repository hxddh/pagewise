//! What a file is, and whether PageWise can open it (24.0).
//!
//! Until 24.0 a file was what its extension said. A DOCX or a HEIC photo
//! dropped on the window was silently not granted, a TIFF passed every check
//! and then showed nothing on Windows (WebView2 cannot decode it), a 300 MB
//! PDF "opened" and then failed on every page preview, and an encrypted or
//! damaged PDF reached the reader as the extractor's own English sentence.
//!
//! Now the first bytes decide what a file is, its size is checked before
//! anything reads it whole, and every refusal is a stable code the front end
//! turns into a translated message with a next step (`src/lib/open-error.ts`).
//! The code leads the message, `"<code>: <detail>"`, so logs keep the detail.

use std::fmt::Display;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// The largest file PageWise opens. The page previews read the whole file
/// through `read_file_bytes`, so a larger one would open and then fail on
/// every page; refusing it up front is the honest version of that.
pub const MAX_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;

/// A PDF that needs a password to open (a user password; owner-only
/// "protected" PDFs open, pdf-inspector tries the empty password).
pub const PDF_ENCRYPTED: &str = "pdf-encrypted";
/// A PDF whose structure cannot be read: truncated, no xref, no pages.
pub const PDF_DAMAGED: &str = "pdf-damaged";
/// Larger than `MAX_DOCUMENT_BYTES`. Detail: `"<len> bytes; max <max>"`.
pub const FILE_TOO_LARGE: &str = "file-too-large";
/// Neither a PDF nor an image this platform's webview can show.
pub const UNSUPPORTED_TYPE: &str = "unsupported-type";

pub fn coded(code: &str, detail: impl Display) -> String {
    format!("{code}: {detail}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Pdf,
    Image,
}

/// How far into a file the PDF header may sit. pdf.js accepts `%PDF-` within
/// the first 1,024 bytes (some generators prepend junk), so this does too.
const HEAD_BYTES: usize = 1024;

/// What the first bytes say a file is, among the formats PageWise opens.
/// `None` for anything else — DOCX (a ZIP), HEIC, and TIFF where the webview
/// cannot decode it.
pub fn sniff(head: &[u8]) -> Option<DocumentKind> {
    if head.windows(5).any(|w| w == b"%PDF-") {
        return Some(DocumentKind::Pdf);
    }
    let image = head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(b"\xFF\xD8\xFF")
        || head.starts_with(b"GIF87a")
        || head.starts_with(b"GIF89a")
        || (head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP")
        || head.starts_with(b"BM")
        || (TIFF_DECODES && (head.starts_with(b"II*\0") || head.starts_with(b"MM\0*")));
    image.then_some(DocumentKind::Image)
}

/// Whether the webview can show a TIFF: WebKit on macOS can; WebView2 on
/// Windows and WebKitGTK on Linux cannot, so there it is refused at the door
/// rather than opened as a blank page.
const TIFF_DECODES: bool = cfg!(target_os = "macos");

/// The first bytes of a file, enough for `sniff`.
pub fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(HEAD_BYTES);
    std::fs::File::open(path)?
        .take(HEAD_BYTES as u64)
        .read_to_end(&mut head)?;
    Ok(head)
}

/// Whether a file is a document PageWise opens, by its content.
pub fn is_document_file(path: &Path) -> bool {
    path.is_file() && read_head(path).map(|h| sniff(&h).is_some()).unwrap_or(false)
}

/// Refuse a file larger than `MAX_DOCUMENT_BYTES`, from its metadata alone.
pub fn check_size(path: &Path) -> Result<(), String> {
    let len = std::fs::metadata(path)
        .map_err(|e| format!("Read failed: {e}"))?
        .len();
    if len > MAX_DOCUMENT_BYTES {
        return Err(coded(
            FILE_TOO_LARGE,
            format!("{len} bytes; max {MAX_DOCUMENT_BYTES}"),
        ));
    }
    Ok(())
}

/// What a file is, checked before it is opened: its size, then its content.
pub fn check_document(path: &Path) -> Result<DocumentKind, String> {
    check_size(path)?;
    let head = read_head(path).map_err(|e| format!("Read failed: {e}"))?;
    sniff(&head).ok_or_else(|| coded(UNSUPPORTED_TYPE, "not a PDF or a supported image"))
}

/// The extractor's error as a coded message. I/O failures keep their own
/// text: they are about the disk, not the file's contents.
pub fn pdf_error(e: &pdf_inspector::PdfError) -> String {
    use pdf_inspector::PdfError;
    match e {
        PdfError::Encrypted => coded(PDF_ENCRYPTED, e),
        PdfError::Io(_) => format!("PDF read failed: {e}"),
        PdfError::Parse(_) | PdfError::InvalidStructure => coded(PDF_DAMAGED, e),
        // No PDF header at all (a ZIP named .pdf, an empty file): what
        // `check_document` says of the same file before it gets here.
        PdfError::NotAPdf(_) => coded(UNSUPPORTED_TYPE, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pagewise-doc-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::File::create(&path).unwrap().write_all(bytes).unwrap();
        path
    }

    #[test]
    fn the_content_decides_not_the_extension() {
        assert_eq!(sniff(b"%PDF-1.7\n"), Some(DocumentKind::Pdf));
        // Junk before the header, as pdf.js tolerates.
        assert_eq!(sniff(b"\r\n\r\n%PDF-1.4\n"), Some(DocumentKind::Pdf));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\0\0"), Some(DocumentKind::Image));
        assert_eq!(sniff(b"\xFF\xD8\xFF\xE0"), Some(DocumentKind::Image));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(DocumentKind::Image));
        // A PDF named .png is a PDF; a JPEG named .pdf is an image.
        let pdf = temp_file("really-a-pdf.png", b"%PDF-1.4\n%%EOF\n");
        assert_eq!(check_document(&pdf), Ok(DocumentKind::Pdf));
        let jpeg = temp_file("really-a-jpeg.pdf", b"\xFF\xD8\xFF\xE0\0\x10JFIF");
        assert_eq!(check_document(&jpeg), Ok(DocumentKind::Image));
    }

    #[test]
    fn an_unsupported_type_is_refused_with_its_code() {
        // DOCX is a ZIP; HEIC is an ISO-BMFF `ftyp` box.
        let docx = temp_file("report.docx", b"PK\x03\x04\x14\0\x06\0[Content_Types].xml");
        let heic = temp_file("photo.pdf", b"\0\0\0\x18ftypheic\0\0\0\0mif1heic");
        for path in [&docx, &heic] {
            let err = check_document(path).unwrap_err();
            assert!(err.starts_with(UNSUPPORTED_TYPE), "{err}");
            assert!(!is_document_file(path));
        }
        // TIFF only where the webview can draw it.
        assert_eq!(sniff(b"II*\0\x08\0\0\0").is_some(), cfg!(target_os = "macos"));
    }

    #[test]
    fn an_oversize_file_is_refused_before_it_is_read() {
        // Sparse: the length is what is checked, nothing is written.
        let path = temp_file("huge.pdf", b"%PDF-1.4\n");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        let err = check_document(&path).unwrap_err();
        assert_eq!(
            err,
            format!(
                "{FILE_TOO_LARGE}: {} bytes; max {MAX_DOCUMENT_BYTES}",
                MAX_DOCUMENT_BYTES + 1
            )
        );
        let _ = std::fs::remove_file(&path);
    }
}
