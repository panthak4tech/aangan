//! The only place in Aangan that talks to the internet.

pub mod allow;
pub mod download;
pub mod gate;

pub use allow::{is_allowed, Purpose};
pub use download::{download, DlError, DlState, DownloadSpec, Progress};
pub use gate::{NetError, NetGate, NetRecord, NetResponse, NetState};
