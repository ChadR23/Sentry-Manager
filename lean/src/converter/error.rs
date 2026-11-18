//! The converter's error: a code (as the Node error's `code`, empty when the
//! Node code throws a plain TypeError/RangeError without one), the message
//! and, where the Node code sets it, a `path` into the inspected file.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CError {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

impl CError {
    pub fn new(code: &str, message: impl Into<String>) -> CError {
        CError { code: code.to_string(), message: message.into(), path: None }
    }
    /// A JS TypeError / RangeError: no code.
    pub fn type_error(message: impl Into<String>) -> CError {
        CError { code: String::new(), message: message.into(), path: None }
    }
    /// `Object.assign(new Error(code), { code })`
    pub fn code(code: &str) -> CError {
        CError::new(code, code)
    }
    pub fn with_path(mut self, path: impl Into<String>) -> CError {
        if self.path.is_none() {
            self.path = Some(path.into());
        }
        self
    }
    /// `error.code || fallback`
    pub fn code_or<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.code.is_empty() {
            fallback
        } else {
            &self.code
        }
    }
}

impl fmt::Display for CError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code.is_empty() {
            write!(f, "{}", self.message)
        } else {
            write!(f, "{}: {}", self.code, self.message)
        }
    }
}

impl std::error::Error for CError {}

impl From<std::io::Error> for CError {
    fn from(e: std::io::Error) -> CError {
        CError::new(super::owned::errno_code(&e), e.to_string())
    }
}

pub type CResult<T> = Result<T, CError>;
