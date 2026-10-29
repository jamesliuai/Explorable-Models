//! Every shared fixture must reach its declared decision in Rust (the TypeScript suite checks the same files).

#[path = "../src/fixtures.rs"]
mod fixtures;

#[test]
fn shared_fixtures_match_their_declared_expectation() {
    let decisions = fixtures::decide_all(&fixtures::default_root()).expect("fixtures are readable");
    assert!(decisions.len() >= 26 * 8, "expected the full fixture corpus, found {}", decisions.len());
    let mismatches: Vec<String> = decisions
        .iter()
        .filter(|decision| (decision.expect == "valid") != decision.valid)
        .map(|decision| format!("{} (expected {}, Rust valid={})", decision.file, decision.expect, decision.valid))
        .collect();
    assert!(mismatches.is_empty(), "fixture decisions differ:\n{}", mismatches.join("\n"));
}

#[test]
fn every_contract_has_valid_and_invalid_fixtures() {
    let decisions = fixtures::decide_all(&fixtures::default_root()).expect("fixtures are readable");
    for name in study_harness_contracts::contract_names() {
        let valid = decisions.iter().filter(|decision| decision.contract == name && decision.expect == "valid").count();
        let invalid = decisions.iter().filter(|decision| decision.contract == name && decision.expect == "invalid").count();
        assert!(valid >= 2 && invalid >= 6, "{name}: {valid} valid and {invalid} invalid fixtures");
    }
}
