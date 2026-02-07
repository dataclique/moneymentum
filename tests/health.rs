#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::io::Write;
use std::net::TcpListener;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use tempfile::NamedTempFile;

fn find_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct ServerGuard(Child);

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn wait_for_server(url: &str, timeout: Duration) -> Result<(), &'static str> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if reqwest::blocking::get(url).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("server did not start in time")
}

#[test]
fn health_endpoint_returns_ok() {
    let port = find_free_port();

    let mut config_file = NamedTempFile::new().unwrap();
    writeln!(config_file, "port = {port}").unwrap();

    let server = Command::new(env!("CARGO_BIN_EXE_moneymentum"))
        .env("CONFIG_PATH", config_file.path())
        .env("DATABASE_URL", "sqlite::memory:")
        .spawn()
        .unwrap();
    let _guard = ServerGuard(server);

    let url = format!("http://127.0.0.1:{port}/health");
    wait_for_server(&url, Duration::from_secs(5)).unwrap();

    let response = reqwest::blocking::get(&url).unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().unwrap(), "ok");
}
