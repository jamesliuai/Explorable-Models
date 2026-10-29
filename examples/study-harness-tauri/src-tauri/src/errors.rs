//! Stable host error codes (the `DiagnosticCode` vocabulary of `@explorable-models/activity`). The webview receives only
//! `{ code, message }` (plus `reason` on a HostPort refusal) with a fixed sentence per code: no field names, no input
//! values and no storage details.
//!
//! **HostPort refusal convention** (`@explorable-models/activity`): a `HostPort` method that refuses a request as a host
//! decision rejects with one of `POLICY_DENIED`, `POLICY_EXPIRED`, `CONTENT_REVOKED`, `STALE_POLICY_REVISION` or
//! `INVALID_INPUT`, and the adapter does not retry it; any other rejection is a retryable persistence failure. The
//! HostPort commands report their errors through [`HostError::host_port`]: a host decision is reported under its
//! convention code with the specific host code as `reason`, and a storage failure (`PERSISTENCE_FAILED`, or
//! `INTEGRITY_FAILURE` for stored bytes) keeps its own code so it stays distinct from every refusal.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    InvalidInput,
    Schema,
    ResourceLimit,
    NotFound,
    Conflict,
    OperationConflict,
    StaleActivityRevision,
    StalePolicyRevision,
    PolicyDenied,
    PolicyExpired,
    ContentRevoked,
    InvalidReference,
    ReceiptMismatch,
    OutOfDomain,
    IntegrityFailure,
    PersistenceFailed,
    UnsupportedArtifact,
    IndependentContext,
}

impl Code {
    pub const fn as_str(self) -> &'static str {
        match self {
            Code::InvalidInput => "INVALID_INPUT",
            Code::Schema => "SCHEMA",
            Code::ResourceLimit => "RESOURCE_LIMIT",
            Code::NotFound => "NOT_FOUND",
            Code::Conflict => "CONFLICT",
            Code::OperationConflict => "OPERATION_CONFLICT",
            Code::StaleActivityRevision => "STALE_ACTIVITY_REVISION",
            Code::StalePolicyRevision => "STALE_POLICY_REVISION",
            Code::PolicyDenied => "POLICY_DENIED",
            Code::PolicyExpired => "POLICY_EXPIRED",
            Code::ContentRevoked => "CONTENT_REVOKED",
            Code::InvalidReference => "INVALID_REFERENCE",
            Code::ReceiptMismatch => "RECEIPT_MISMATCH",
            Code::OutOfDomain => "OUT_OF_DOMAIN",
            Code::IntegrityFailure => "INTEGRITY_FAILURE",
            Code::PersistenceFailed => "PERSISTENCE_FAILED",
            Code::UnsupportedArtifact => "UNSUPPORTED_ARTIFACT",
            Code::IndependentContext => "INDEPENDENT_CONTEXT",
        }
    }

    /// Fixed, content-free sentence for the code.
    pub const fn message(self) -> &'static str {
        match self {
            Code::InvalidInput => "The request body is not a bounded JSON request.",
            Code::Schema => "The request does not match its contract.",
            Code::ResourceLimit => "The request is larger than the host accepts.",
            Code::NotFound => "The host holds no matching record.",
            Code::Conflict => "The request conflicts with a record the host already holds.",
            Code::OperationConflict => "This operation key was already used for a different request.",
            Code::StaleActivityRevision => "The request is based on another activity revision or stage.",
            Code::StalePolicyRevision => "The request is based on another policy revision.",
            Code::PolicyDenied => "The host policy does not permit this request.",
            Code::PolicyExpired => "The host policy has expired.",
            Code::ContentRevoked => "The host no longer approves this activity's content.",
            Code::InvalidReference => "The request names content the host has not approved.",
            Code::ReceiptMismatch => "The receipt does not belong to this record.",
            Code::OutOfDomain => "A requested range lies outside the approved domain.",
            Code::IntegrityFailure => "Stored or supplied data failed its integrity check.",
            Code::PersistenceFailed => "The host could not complete the durable write.",
            Code::UnsupportedArtifact => "The artifact cannot be accepted by this host.",
            Code::IndependentContext => "The activity is in an independent-task context.",
        }
    }

    /// Storage-side failures: the request may succeed when resent. Every other code is a host decision.
    const fn is_storage(self) -> bool {
        matches!(self, Code::PersistenceFailed | Code::IntegrityFailure)
    }

    /// The convention code a host decision is reported under on a HostPort method.
    pub const fn refusal(self) -> Code {
        match self {
            Code::PolicyDenied | Code::IndependentContext | Code::OutOfDomain => Code::PolicyDenied,
            Code::PolicyExpired => Code::PolicyExpired,
            Code::ContentRevoked => Code::ContentRevoked,
            Code::StalePolicyRevision => Code::StalePolicyRevision,
            _ => Code::InvalidInput,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostError {
    /// The specific host code (the reported code for every command that is not a HostPort method).
    pub code: Code,
    /// A host decision even though the code also names a storage failure (supplied data failing its integrity check).
    decision: bool,
    /// Set by [`HostError::host_port`] for a refusal: the convention code reported in place of `code`.
    reported: Option<Code>,
}

impl HostError {
    /// An error whose class follows its code: storage failure for `PERSISTENCE_FAILED`/`INTEGRITY_FAILURE`, a host
    /// decision otherwise.
    pub const fn new(code: Code) -> Self {
        Self { code, decision: !code.is_storage(), reported: None }
    }

    /// A host decision about the request itself, whatever the code (e.g. a supplied artifact failing its integrity check).
    pub const fn refused(code: Code) -> Self {
        Self { code, decision: true, reported: None }
    }

    pub const fn is_refusal(&self) -> bool {
        self.decision
    }

    /// The error as a HostPort method reports it: a host decision under its convention code with `reason` = the
    /// specific code; a storage failure unchanged.
    pub const fn host_port(self) -> Self {
        Self { reported: if self.is_refusal() { Some(self.code.refusal()) } else { None }, ..self }
    }

    /// The code the webview receives.
    pub const fn reported_code(&self) -> Code {
        match self.reported {
            Some(code) => code,
            None => self.code,
        }
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.reported_code().as_str())
    }
}

impl std::error::Error for HostError {}

impl Serialize for HostError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = if self.reported.is_some() { 3 } else { 2 };
        let mut state = serializer.serialize_struct("HostError", fields)?;
        state.serialize_field("code", self.reported_code().as_str())?;
        state.serialize_field("message", self.code.message())?;
        if self.reported.is_some() {
            state.serialize_field("reason", self.code.as_str())?;
        }
        state.end()
    }
}

impl From<rusqlite::Error> for HostError {
    fn from(_: rusqlite::Error) -> Self {
        HostError::new(Code::PersistenceFailed)
    }
}

impl From<std::io::Error> for HostError {
    fn from(_: std::io::Error) -> Self {
        HostError::new(Code::PersistenceFailed)
    }
}

pub type HostResult<T> = Result<T, HostError>;

/// Shorthand for an error result.
pub fn fail<T>(code: Code) -> HostResult<T> {
    Err(HostError::new(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The codes a HostPort method rejects with for a host decision (never retried by the adapter).
    const HOST_REFUSAL_CODES: &[Code] =
        &[Code::PolicyDenied, Code::PolicyExpired, Code::ContentRevoked, Code::StalePolicyRevision, Code::InvalidInput];

    fn wire(error: HostError) -> serde_json::Value {
        serde_json::to_value(error).unwrap()
    }

    #[test]
    fn host_decisions_are_reported_under_the_refusal_convention() {
        let cases = [
            (Code::PolicyDenied, "POLICY_DENIED"),
            (Code::IndependentContext, "POLICY_DENIED"),
            (Code::OutOfDomain, "POLICY_DENIED"),
            (Code::PolicyExpired, "POLICY_EXPIRED"),
            (Code::ContentRevoked, "CONTENT_REVOKED"),
            (Code::StalePolicyRevision, "STALE_POLICY_REVISION"),
            (Code::StaleActivityRevision, "INVALID_INPUT"),
            (Code::InvalidReference, "INVALID_INPUT"),
            (Code::ReceiptMismatch, "INVALID_INPUT"),
            (Code::Conflict, "INVALID_INPUT"),
            (Code::OperationConflict, "INVALID_INPUT"),
            (Code::NotFound, "INVALID_INPUT"),
            (Code::Schema, "INVALID_INPUT"),
            (Code::ResourceLimit, "INVALID_INPUT"),
            (Code::InvalidInput, "INVALID_INPUT"),
            (Code::UnsupportedArtifact, "INVALID_INPUT"),
        ];
        for (code, reported) in cases {
            let error = HostError::new(code).host_port();
            assert!(error.is_refusal(), "{code:?}");
            assert!(HOST_REFUSAL_CODES.contains(&error.reported_code()), "{code:?}");
            assert_eq!(wire(error), serde_json::json!({ "code": reported, "message": code.message(), "reason": code.as_str() }), "{code:?}");
        }
    }

    #[test]
    fn storage_failures_stay_distinct_from_refusals() {
        for code in [Code::PersistenceFailed, Code::IntegrityFailure] {
            let error = HostError::new(code).host_port();
            assert!(!error.is_refusal());
            assert!(!HOST_REFUSAL_CODES.contains(&error.reported_code()));
            assert_eq!(wire(error), serde_json::json!({ "code": code.as_str(), "message": code.message() }));
        }
        let io: HostError = std::io::Error::other("disk full").into();
        assert_eq!(wire(io.host_port())["code"], "PERSISTENCE_FAILED");
        // Supplied data failing its integrity check is a decision about the request, not a storage failure.
        assert_eq!(
            wire(HostError::refused(Code::IntegrityFailure).host_port()),
            serde_json::json!({ "code": "INVALID_INPUT", "message": Code::IntegrityFailure.message(), "reason": "INTEGRITY_FAILURE" })
        );
    }

    #[test]
    fn host_owned_commands_keep_their_specific_codes() {
        assert_eq!(wire(HostError::new(Code::Schema)), serde_json::json!({ "code": "SCHEMA", "message": Code::Schema.message() }));
        assert_eq!(HostError::new(Code::NotFound).to_string(), "NOT_FOUND");
        assert_eq!(HostError::new(Code::NotFound).host_port().to_string(), "INVALID_INPUT");
    }
}
