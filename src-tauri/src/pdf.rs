use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PageText {
    pub page: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PdfExtractResult {
    pub pages: Vec<PageText>,
    pub total_pages: u32,
}

pub fn extract_pdf_text(path: &str, page: Option<u32>) -> Result<PdfExtractResult, String> {
    let pages_raw =
        pdf_extract::extract_text_by_pages(path).map_err(|e| format!("PDF extract failed: {e}"))?;

    let all_pages: Vec<PageText> = pages_raw
        .into_iter()
        .enumerate()
        .map(|(idx, text)| PageText {
            page: (idx + 1) as u32,
            text,
        })
        .collect();

    let total_pages = all_pages.len() as u32;

    let pages = match page {
        Some(p) if p >= 1 && p <= total_pages => {
            vec![all_pages[(p - 1) as usize].clone()]
        }
        Some(p) => {
            return Err(format!("Page {p} out of range (1-{total_pages})"));
        }
        None => all_pages,
    };

    Ok(PdfExtractResult {
        pages,
        total_pages,
    })
}
