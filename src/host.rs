extern "C" {
    pub fn debug_log(val: i32);
    pub fn abort_js() -> !;
    pub fn emscripten_random() -> f32;
    pub fn emscripten_date_now() -> f64;
    pub fn console_write(fd: i32, ptr: i32, len: i32);
}
