//! PDF post-processing with PDFKit (#95, `typora.export.pdf-options`):
//! running header/footer with page numbers, bookmark outline from the headings,
//! internal `#id` links turned into in-document jumps, and the info dictionary.
//!
//! Works on the finished PDF in place (PDFKit annotations / outline, no page
//! redraw), so the text layer and fonts WebKit produced stay untouched.

use crate::export_cmds::{OutlineItem, PdfOptions, link_fragment, outline_parents, page_text};
use objc2::rc::{Allocated, Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::msg_send;
use objc2_foundation::{NSMutableDictionary, NSPoint, NSRect, NSSize, NSString, NSURL};
use std::collections::HashMap;
use std::path::Path;

#[link(name = "PDFKit", kind = "framework")]
unsafe extern "C" {
    static PDFAnnotationSubtypeFreeText: &'static NSString;
    static PDFDocumentTitleAttribute: &'static NSString;
    static PDFDocumentAuthorAttribute: &'static NSString;
    static PDFDocumentSubjectAttribute: &'static NSString;
    static PDFDocumentKeywordsAttribute: &'static NSString;
    static PDFDocumentCreatorAttribute: &'static NSString;
}

const CROP_BOX: isize = 1; // kPDFDisplayBoxCropBox
const BAND_HEIGHT: f64 = 14.0;

fn class(name: &str) -> Result<&'static AnyClass, String> {
    AnyClass::get(&std::ffi::CString::new(name).unwrap()).ok_or_else(|| format!("PDFKit class {name} unavailable"))
}

unsafe fn alloc(cls: &AnyClass) -> Allocated<AnyObject> {
    unsafe { msg_send![cls, alloc] }
}

/// Where each heading starts: (page index, point) found by searching its text in order.
unsafe fn locate_headings(doc: &AnyObject, items: &[OutlineItem]) -> Vec<Option<(usize, NSPoint)>> {
    let mut out = Vec::with_capacity(items.len());
    let mut cursor: (usize, f64) = (0, f64::INFINITY); // page, y (PDF y grows upwards)
    for it in items {
        let needle = NSString::from_str(&it.text);
        let found: Option<Retained<AnyObject>> = unsafe { msg_send![doc, findString: &*needle, withOptions: 1usize] };
        let mut best: Option<(usize, NSPoint)> = None;
        if let Some(arr) = found {
            let n: usize = unsafe { msg_send![&*arr, count] };
            for i in 0..n {
                let sel: Retained<AnyObject> = unsafe { msg_send![&*arr, objectAtIndex: i] };
                let pages: Retained<AnyObject> = unsafe { msg_send![&*sel, pages] };
                let pc: usize = unsafe { msg_send![&*pages, count] };
                if pc == 0 {
                    continue;
                }
                let page: Retained<AnyObject> = unsafe { msg_send![&*pages, objectAtIndex: 0usize] };
                let idx: usize = unsafe { msg_send![doc, indexForPage: &*page] };
                let r: NSRect = unsafe { msg_send![&*sel, boundsForPage: &*page] };
                let top = r.origin.y + r.size.height;
                if idx > cursor.0 || (idx == cursor.0 && top <= cursor.1 + 0.5) {
                    best = Some((idx, NSPoint::new(r.origin.x, top + 6.0)));
                    break;
                }
            }
        }
        if let Some((idx, p)) = best {
            cursor = (idx, p.y - 6.0 - 0.5);
        }
        out.push(best);
    }
    out
}

unsafe fn destination(doc: &AnyObject, page_idx: usize, at: NSPoint) -> Result<Retained<AnyObject>, String> {
    let page: Retained<AnyObject> = unsafe { msg_send![doc, pageAtIndex: page_idx] };
    let d: Option<Retained<AnyObject>> = unsafe { msg_send![alloc(class("PDFDestination")?), initWithPage: &*page, atPoint: at] };
    d.ok_or_else(|| "PDFDestination init failed".into())
}

unsafe fn add_outline(doc: &AnyObject, items: &[OutlineItem], spots: &[Option<(usize, NSPoint)>]) -> Result<(), String> {
    let cls = class("PDFOutline")?;
    let root: Retained<AnyObject> = unsafe { msg_send![alloc(cls), init] };
    let parents = outline_parents(items);
    let mut nodes: Vec<Retained<AnyObject>> = Vec::with_capacity(items.len());
    let mut last_spot = (0usize, NSPoint::new(0.0, 0.0));
    for (i, it) in items.iter().enumerate() {
        let node: Retained<AnyObject> = unsafe { msg_send![alloc(cls), init] };
        let label = NSString::from_str(&it.text);
        let _: () = unsafe { msg_send![&*node, setLabel: &*label] };
        // Unlocated headings (e.g. text broken across lines) point at the previous one.
        let spot = spots[i].unwrap_or(last_spot);
        last_spot = spot;
        let dest = unsafe { destination(doc, spot.0, spot.1)? };
        let _: () = unsafe { msg_send![&*node, setDestination: &*dest] };
        let parent: &AnyObject = parents[i].map(|p| &*nodes[p]).unwrap_or(&*root);
        let n: usize = unsafe { msg_send![parent, numberOfChildren] };
        let _: () = unsafe { msg_send![parent, insertChild: &*node, atIndex: n] };
        nodes.push(node);
    }
    let _: () = unsafe { msg_send![doc, setOutlineRoot: &*root] };
    Ok(())
}

/// Same-document links (`…#id`) → GoTo the heading with that id.
unsafe fn fix_internal_links(doc: &AnyObject, items: &[OutlineItem], spots: &[Option<(usize, NSPoint)>]) -> Result<usize, String> {
    let by_id: HashMap<&str, (usize, NSPoint)> =
        items.iter().zip(spots).filter_map(|(it, s)| s.map(|s| (it.id.as_str(), s))).filter(|(id, _)| !id.is_empty()).collect();
    if by_id.is_empty() {
        return Ok(0);
    }
    let goto_cls = class("PDFActionGoTo")?;
    let pages: usize = unsafe { msg_send![doc, pageCount] };
    let mut fixed = 0;
    for p in 0..pages {
        let page: Retained<AnyObject> = unsafe { msg_send![doc, pageAtIndex: p] };
        let annots: Retained<AnyObject> = unsafe { msg_send![&*page, annotations] };
        let n: usize = unsafe { msg_send![&*annots, count] };
        for i in 0..n {
            let a: Retained<AnyObject> = unsafe { msg_send![&*annots, objectAtIndex: i] };
            let url: Option<Retained<NSURL>> = unsafe { msg_send![&*a, URL] };
            let Some(url) = url else { continue };
            let Some(s) = url.absoluteString() else { continue };
            let s = s.to_string();
            if s.starts_with("http:") || s.starts_with("https:") || s.starts_with("mailto:") {
                continue;
            }
            let Some(frag) = link_fragment(&s) else { continue };
            let Some(&(idx, at)) = by_id.get(frag.as_str()) else { continue };
            let dest = unsafe { destination(doc, idx, at)? };
            let action: Retained<AnyObject> = unsafe { msg_send![alloc(goto_cls), initWithDestination: &*dest] };
            let _: () = unsafe { msg_send![&*a, setURL: std::ptr::null::<NSURL>()] };
            let _: () = unsafe { msg_send![&*a, setAction: &*action] };
            fixed += 1;
        }
    }
    Ok(fixed)
}

unsafe fn add_band(page: &AnyObject, rect: NSRect, text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let ann: Retained<AnyObject> = unsafe {
        msg_send![alloc(class("PDFAnnotation")?), initWithBounds: rect, forType: PDFAnnotationSubtypeFreeText, withProperties: std::ptr::null::<AnyObject>()]
    };
    let s = NSString::from_str(text);
    let _: () = unsafe { msg_send![&*ann, setContents: &*s] };
    let font: Retained<AnyObject> = unsafe { msg_send![class("NSFont")?, systemFontOfSize: 8.0f64] };
    let _: () = unsafe { msg_send![&*ann, setFont: &*font] };
    let gray: Retained<AnyObject> = unsafe { msg_send![class("NSColor")?, grayColor] };
    let clear: Retained<AnyObject> = unsafe { msg_send![class("NSColor")?, clearColor] };
    let _: () = unsafe { msg_send![&*ann, setFontColor: &*gray] };
    let _: () = unsafe { msg_send![&*ann, setColor: &*clear] };
    let _: () = unsafe { msg_send![&*ann, setAlignment: 1isize] }; // NSTextAlignmentCenter
    let border: Retained<AnyObject> = unsafe { msg_send![alloc(class("PDFBorder")?), init] };
    let _: () = unsafe { msg_send![&*border, setLineWidth: 0.0f64] };
    let _: () = unsafe { msg_send![&*ann, setBorder: &*border] };
    let _: () = unsafe { msg_send![&*ann, setReadOnly: Bool::YES] };
    let _: () = unsafe { msg_send![page, addAnnotation: &*ann] };
    Ok(())
}

unsafe fn add_header_footer(doc: &AnyObject, header: Option<&str>, footer: Option<&str>) -> Result<(), String> {
    let total: usize = unsafe { msg_send![doc, pageCount] };
    for p in 0..total {
        let page: Retained<AnyObject> = unsafe { msg_send![doc, pageAtIndex: p] };
        let b: NSRect = unsafe { msg_send![&*page, boundsForBox: CROP_BOX] };
        let w = b.size.width - 72.0;
        if let Some(h) = header {
            let r = NSRect::new(NSPoint::new(b.origin.x + 36.0, b.origin.y + b.size.height - 12.0 - BAND_HEIGHT), NSSize::new(w, BAND_HEIGHT));
            unsafe { add_band(&page, r, &page_text(h, p + 1, total))? };
        }
        if let Some(f) = footer {
            let r = NSRect::new(NSPoint::new(b.origin.x + 36.0, b.origin.y + 10.0), NSSize::new(w, BAND_HEIGHT));
            unsafe { add_band(&page, r, &page_text(f, p + 1, total))? };
        }
    }
    Ok(())
}

unsafe fn set_attributes(doc: &AnyObject, opts: &PdfOptions) {
    let dict = NSMutableDictionary::<NSString, AnyObject>::new();
    let put = |k: &NSString, v: &str| {
        if !v.is_empty() {
            let s = NSString::from_str(v);
            let obj: &AnyObject = s.as_ref();
            unsafe { dict.setObject_forKey(obj, objc2::runtime::ProtocolObject::from_ref(k)) };
        }
    };
    put(unsafe { PDFDocumentCreatorAttribute }, "Margin");
    if let Some(m) = &opts.meta {
        put(unsafe { PDFDocumentTitleAttribute }, &m.title);
        put(unsafe { PDFDocumentAuthorAttribute }, &m.author);
        put(unsafe { PDFDocumentSubjectAttribute }, &m.subject);
        let kws: Vec<String> = m.keywords.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect();
        if !kws.is_empty() {
            let arr: Retained<AnyObject> = unsafe { msg_send![class("NSMutableArray").unwrap(), array] };
            for k in kws {
                let s = NSString::from_str(&k);
                let _: () = unsafe { msg_send![&*arr, addObject: &*s] };
            }
            unsafe { dict.setObject_forKey(&*arr, objc2::runtime::ProtocolObject::from_ref(PDFDocumentKeywordsAttribute)) };
        }
    }
    let _: () = unsafe { msg_send![doc, setDocumentAttributes: &*dict] };
}

/// Apply header/footer, outline, internal links and metadata to the PDF at `path` (in place).
pub fn post_process(path: &Path, opts: &PdfOptions) -> Result<(), String> {
    autoreleasepool(|_| unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let doc: Option<Retained<AnyObject>> = msg_send![alloc(class("PDFDocument")?), initWithURL: &*url];
        let doc = doc.ok_or("could not reopen the exported PDF")?;
        let items: &[OutlineItem] = opts.outline.as_deref().unwrap_or(&[]);
        if !items.is_empty() {
            let spots = locate_headings(&doc, items);
            add_outline(&doc, items, &spots)?;
            fix_internal_links(&doc, items, &spots)?;
        }
        let nonempty = |s: &Option<String>| s.as_deref().filter(|x| !x.trim().is_empty()).map(str::to_string);
        let (h, f) = (nonempty(&opts.header), nonempty(&opts.footer));
        if h.is_some() || f.is_some() {
            add_header_footer(&doc, h.as_deref(), f.as_deref())?;
        }
        set_attributes(&doc, opts);
        let tmp = path.with_extension("pdf.tmp");
        let tmp_url = NSURL::fileURLWithPath(&NSString::from_str(&tmp.to_string_lossy()));
        let ok: Bool = msg_send![&*doc, writeToURL: &*tmp_url];
        if !ok.as_bool() {
            let _ = std::fs::remove_file(&tmp);
            return Err("could not write the post-processed PDF".into());
        }
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    })
}

/// Reader used by tests: (page count, outline labels, annotation contents of page 1, title, internal GoTo links).
#[cfg(test)]
pub fn inspect(path: &Path) -> (usize, Vec<String>, Vec<String>, String, usize) {
    autoreleasepool(|_| unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let doc: Retained<AnyObject> = msg_send![alloc(class("PDFDocument").unwrap()), initWithURL: &*url];
        let pages: usize = msg_send![&*doc, pageCount];
        let mut labels = Vec::new();
        let root: Option<Retained<AnyObject>> = msg_send![&*doc, outlineRoot];
        fn walk(n: &AnyObject, out: &mut Vec<String>) {
            let c: usize = unsafe { msg_send![n, numberOfChildren] };
            for i in 0..c {
                let ch: Retained<AnyObject> = unsafe { msg_send![n, childAtIndex: i] };
                let l: Option<Retained<NSString>> = unsafe { msg_send![&*ch, label] };
                out.push(l.map(|s| s.to_string()).unwrap_or_default());
                walk(&ch, out);
            }
        }
        if let Some(r) = root {
            walk(&r, &mut labels);
        }
        let mut contents = Vec::new();
        let mut gotos = 0;
        for p in 0..pages {
            let page: Retained<AnyObject> = msg_send![&*doc, pageAtIndex: p];
            let annots: Retained<AnyObject> = msg_send![&*page, annotations];
            let n: usize = msg_send![&*annots, count];
            for i in 0..n {
                let a: Retained<AnyObject> = msg_send![&*annots, objectAtIndex: i];
                if p == 0 {
                    let c: Option<Retained<NSString>> = msg_send![&*a, contents];
                    if let Some(c) = c {
                        contents.push(c.to_string());
                    }
                }
                let act: Option<Retained<AnyObject>> = msg_send![&*a, action];
                if let Some(act) = act {
                    let is_goto: Bool = msg_send![&*act, isKindOfClass: class("PDFActionGoTo").unwrap()];
                    if is_goto.as_bool() {
                        gotos += 1;
                    }
                }
            }
        }
        let attrs: Option<Retained<AnyObject>> = msg_send![&*doc, documentAttributes];
        let title = attrs
            .and_then(|d| {
                let v: Option<Retained<NSString>> = msg_send![&*d, objectForKey: PDFDocumentTitleAttribute];
                v
            })
            .map(|s| s.to_string())
            .unwrap_or_default();
        (pages, labels, contents, title, gotos)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export_cmds::Meta;

    /// Two-page PDF: page 1 "Alpha heading" + a link to `#beta`, page 2 "Beta heading".
    fn sample_pdf() -> Vec<u8> {
        let page = |text: &str, annots: &str, contents: u32| {
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {contents} 0 R {annots}>>")
        };
        let stream = |t: &str| {
            let body = format!("BT /F1 24 Tf 72 700 Td ({t}) Tj ET");
            format!("<< /Length {} >>\nstream\n{body}\nendstream", body.len())
        };
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            page("Alpha", "/Annots [8 0 R] ", 6),
            page("Beta", "", 7),
            stream("Alpha heading"),
            stream("Beta heading"),
            "<< /Type /Annot /Subtype /Link /Rect [72 600 300 620] /Border [0 0 0] /A << /S /URI /URI (asset://localhost/doc/#beta) >> >>".to_string(),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offs = Vec::new();
        for (i, o) in objs.iter().enumerate() {
            offs.push(out.len());
            out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).bytes());
        for o in offs {
            out.extend(format!("{o:010} 00000 n \n").bytes());
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).bytes());
        out
    }

    #[test]
    fn post_process_adds_outline_links_header_footer_and_meta() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.pdf");
        std::fs::write(&p, sample_pdf()).unwrap();
        let opts = PdfOptions {
            header: Some("My Doc".into()),
            footer: Some("${pageNo} / ${totalPages}".into()),
            outline: Some(vec![
                OutlineItem { level: 1, text: "Alpha heading".into(), id: "alpha".into() },
                OutlineItem { level: 2, text: "Beta heading".into(), id: "beta".into() },
            ]),
            meta: Some(Meta { title: "Sample Title".into(), author: "Ann".into(), subject: "".into(), keywords: "a, b".into() }),
            paper: None,
        };
        post_process(&p, &opts).unwrap();
        let (pages, labels, contents, title, gotos) = inspect(&p);
        assert_eq!(pages, 2);
        assert_eq!(labels, vec!["Alpha heading", "Beta heading"]);
        assert!(contents.contains(&"My Doc".to_string()), "{contents:?}");
        assert!(contents.contains(&"1 / 2".to_string()), "{contents:?}");
        assert_eq!(title, "Sample Title");
        assert_eq!(gotos, 1, "the #beta link becomes an internal jump");
    }

    #[test]
    fn post_process_missing_file_errors() {
        let r = post_process(Path::new("/nonexistent/margin.pdf"), &PdfOptions { meta: Some(Meta::default()), ..Default::default() });
        assert!(r.is_err());
    }
}
