// Host function imports — these are provided by the JS environment.
// Maps to the 27 imports from the original TinyEMU WASM module.

extern "C" {
    // Console I/O
    pub fn console_write(opaque: u32, buf: u32, len: u32);
    pub fn console_get_size(pw: u32, ph: u32);

    // Display (framebuffer)
    pub fn fb_refresh(opaque: u32, data: u32, x: u32, y: u32, w: u32, h: u32, stride: u32);

    // Network
    pub fn net_recv_packet(opaque: u32, buf: u32, buf_len: u32);

    // Filesystem
    pub fn fs_export_file(filename: u32, buf: u32, buf_len: u32);
    pub fn fs_wget_update_downloading(flag: u32);

    // File buffer operations (used by VFSync)
    pub fn file_buffer_init(bs: u32);
    pub fn file_buffer_read(bs: u32, offset: u32, buf: u32, size: u32);
    pub fn file_buffer_write(bs: u32, offset: u32, buf: u32, size: u32);
    pub fn file_buffer_resize(bs: u32, new_size: u32) -> u32;
    pub fn file_buffer_reset(bs: u32);
    pub fn file_buffer_set(bs: u32, offset: u32, val: u32, size: u32);

    // Async operations
    pub fn emscripten_async_call(func: u32, arg: u32, millis: u32);
    pub fn emscripten_async_wget3_data(
        url: u32, request: u32, user: u32, password: u32,
        post_data: u32, post_data_len: u32,
        arg: u32, free: u32,
        onload: u32, onerror: u32, onprogress: u32,
    ) -> u32;

    // Time
    pub fn emscripten_date_now() -> f64;
    pub fn clock_time_get(clk_id: u32, precision: u64, ptime: u32) -> u32;

    // Random
    pub fn emscripten_random() -> f32;

    // Memory
    pub fn emscripten_resize_heap(requested_size: u32) -> u32;

    // WASI stubs
    pub fn fd_write(fd: u32, iov: u32, iovcnt: u32, pnum: u32) -> u32;
    pub fn fd_seek(fd: u32, offset: u64, whence: u32, new_offset: u32) -> u32;
    pub fn fd_close(fd: u32) -> u32;

    // Time conversion
    pub fn gmtime_js(time: u64, tm_ptr: u32);
    pub fn localtime_js(time: u64, tm_ptr: u32);
    pub fn tzset_js(timezone: u32, daylight: u32, std_name: u32, dst_name: u32);

    // Fatal
    pub fn abort_js() -> !;
    pub fn assert_fail(cond: u32, file: u32, line: u32, func: u32);
    pub fn exit(status: u32);

    // Debug
    pub fn debug_log(code: u32);
}
