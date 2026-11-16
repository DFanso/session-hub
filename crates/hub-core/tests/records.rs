mod common;

use hub_core::ingest::records::classify;

#[test]
fn records_match_goldens() {
    let cases = common::golden("records");
    assert!(!cases.is_empty());
    for c in &cases {
        let input = c.input.as_str().expect("input is a string");
        let got = serde_json::to_value(classify(input)).unwrap();
        assert_eq!(got, c.output, "{}", c.name);
    }
}

#[test]
fn never_store_types_carry_no_content() {
    for t in [
        "api-request",
        "api-request-blob",
        "api-request-shape",
        "file-history-snapshot",
        "file-history-delta",
    ] {
        let line = format!(
            r#"{{"type":"{t}","uuid":"u","body":"SECRET-BODY","message":{{"content":"SECRET-BODY"}}}}"#
        );
        let out = format!("{:?}", classify(&line));
        assert!(!out.contains("SECRET-BODY"), "{t}: {out}");
        assert!(out.contains("never-store"), "{t}");
    }
}
