//! The only place in Aangan that talks to the internet.

pub mod allow;
pub mod gate;

pub use allow::{is_allowed, Purpose};
pub use gate::{NetError, NetGate, NetRecord, NetResponse, NetState};
