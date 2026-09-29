//! `pagewise-eval-extract <file.pdf>...` → one JSON document per file on
//! stdout (JSON Lines): the page text the assistant is given, and the text
//! runs a citation is located against. These are the two extraction paths
//! whose disagreement decides whether a verbatim quote can be found again.
//!
//! `pagewise-eval-extract --annotate <in.pdf> <out.pdf> <annotations.json>`
//! writes annotations with the app's own `annotate.rs`, so the evaluation can
//! read them back the way a PDF reader would (14.1).

#[allow(dead_code)]
#[path = "../../../src-tauri/src/inspect.rs"]
mod inspect;

#[allow(dead_code)]
#[path = "../../../src-tauri/src/annotate.rs"]
mod annotate;

use serde::Serialize;

#[derive(Serialize)]
struct PageDump {
    page: u32,
    text: String,
    needs_vision: bool,
    items: Vec<inspect::TextItemRect>,
    items_error: Option<String>,
}

#[derive(Serialize)]
struct DocDump {
    file: String,
    page_count: u32,
    pages: Vec<PageDump>,
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.first().map(String::as_str) == Some("--annotate") {
        let [_, input, output, json] = files.as_slice() else {
            eprintln!("usage: pagewise-eval-extract --annotate <in.pdf> <out.pdf> <annotations.json>");
            std::process::exit(2);
        };
        let raw = std::fs::read_to_string(json).expect("read annotations");
        let annotations: Vec<annotate::AnnotationIn> = serde_json::from_str(&raw).expect("parse annotations");
        match annotate::annotate_file(std::path::Path::new(input), std::path::Path::new(output), &annotations) {
            Ok(n) => println!("{n}"),
            Err(e) => {
                eprintln!("{input}: {e}");
                std::process::exit(1);
            }
        }
        return;
    }
    if files.is_empty() {
        eprintln!("usage: pagewise-eval-extract <file.pdf>...");
        std::process::exit(2);
    }
    for file in files {
        let model = match inspect::open_document(&file) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("{file}: {e}");
                std::process::exit(1);
            }
        };
        let pages = model
            .pages
            .into_iter()
            .map(|p| {
                let (items, items_error) = match inspect::page_text_items(&file, p.page) {
                    Ok(items) => (items, None),
                    Err(e) => (Vec::new(), Some(e)),
                };
                PageDump { page: p.page, text: p.text, needs_vision: p.needs_vision, items, items_error }
            })
            .collect();
        let dump = DocDump { file: file.clone(), page_count: model.page_count, pages };
        println!("{}", serde_json::to_string(&dump).expect("serialize"));
    }
}
