use std::process::Command;

#[test]
fn cli_help_exposes_scan_and_recommend_commands() {
    let output = Command::new(env!("CARGO_BIN_EXE_aangan"))
        .arg("--help")
        .output()
        .expect("run the aangan CLI help command");

    assert!(output.status.success());
    let help = String::from_utf8_lossy(&output.stdout);
    assert!(help.contains("scan"));
    assert!(help.contains("recommend"));
}
