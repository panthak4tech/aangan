use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallKind {
    Managed,
    External,
    Container,
}

pub struct LaunchPlan {
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub health_path: &'static str,
}

pub struct LaunchOpts {
    pub port: u16,
    pub api_key: String,
    pub ctx: u32,
    pub gpu_layers: i32,
    pub threads: Option<u32>,
}

pub trait RuntimeAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn install_kind(&self) -> InstallKind;
    fn openai_compatible(&self) -> bool {
        true
    }
    fn launch_plan(
        &self,
        install_dir: &Path,
        server_exe: &str,
        model: &Path,
        opts: &LaunchOpts,
    ) -> LaunchPlan;
}
