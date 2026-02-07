#[macro_use]
extern crate rocket;

#[get("/health")]
fn health() -> &'static str {
    "ok"
}

#[launch]
fn rocket() -> _ {
    rocket::build().mount("/", routes![health])
}
