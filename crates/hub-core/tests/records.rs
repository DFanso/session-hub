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

fn user(content: &str) -> String {
    format!(r#"{{"type":"user","uuid":"u","timestamp":"t","message":{{"content":"{content}"}}}}"#)
}

fn owner_text(line: &str) -> String {
    match classify(line) {
        hub_core::ingest::records::Classified::OwnerPrompt { text, .. } => text,
        other => panic!("not an owner prompt: {other:?}"),
    }
}

#[test]
fn lone_high_surrogate_becomes_replacement_char() {
    assert_eq!(owner_text(&user(r"a\ud83d b")), "a\u{FFFD} b");
    assert_eq!(owner_text(&user(r"a\uD83D")), "a\u{FFFD}");
}

#[test]
fn lone_low_surrogate_becomes_replacement_char() {
    assert_eq!(owner_text(&user(r"a\ude00b")), "a\u{FFFD}b");
    assert_eq!(owner_text(&user(r"\ud83d😀")), "\u{FFFD}\u{1F600}");
}

#[test]
fn valid_surrogate_pair_is_unchanged() {
    assert_eq!(owner_text(&user(r"😀")), "\u{1F600}");
    assert_eq!(owner_text(&user(r"😀")), "\u{1F600}");
}

#[test]
fn escaped_backslash_is_not_an_escape() {
    assert_eq!(owner_text(&user(r"\\ud83d")), r"\ud83d");
    assert_eq!(owner_text(&user(r"\\\ud83d")), "\\\u{FFFD}");
}

#[test]
fn lone_surrogate_in_assistant_text_block() {
    let line = r#"{"type":"assistant","uuid":"a","timestamp":"t","message":{"content":[{"type":"text","text":"x\ud800y"}]}}"#;
    match classify(line) {
        hub_core::ingest::records::Classified::AssistantText { text, .. } => {
            assert_eq!(text, "x\u{FFFD}y")
        }
        other => panic!("{other:?}"),
    }
}
