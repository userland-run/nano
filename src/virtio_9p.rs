// VirtIO 9p filesystem device (type 9) — VFSync bridge
// Provides the root filesystem via the 9p protocol over VirtIO.
// Queue 0: request/response (bidirectional 9p messages)
//
// The guest kernel sends 9p protocol messages (Tversion, Tattach, Twalk, etc.)
// via the virtqueue. We process them and respond. For file data, we relay
// to the host via emscripten_async_wget3_data (VFSync HTTP).
//
// TODO: Full 9p protocol implementation. Currently a minimal stub.

use crate::virtio;

// 9p protocol message types
const P9_TVERSION: u8 = 100;
const P9_RVERSION: u8 = 101;
const P9_TATTACH: u8 = 104;
const P9_RATTACH: u8 = 105;
const P9_TSTAT: u8 = 124;
const P9_RSTAT: u8 = 125;
const P9_TWALK: u8 = 110;
const P9_RWALK: u8 = 111;
const P9_RERROR: u8 = 107;

/// Read VirtIO 9p device-specific config.
/// Offset 0x00: tag_len (u16), 0x02: tag (tag_len bytes)
pub unsafe fn config_read(offset: u16, _size: u8) -> u32 {
    let mach = &*(crate::exports::get_machine());
    match offset {
        0 => mach.virtio_9p.mount_tag_len as u32,
        _ if offset >= 2 => {
            let idx = (offset - 2) as usize;
            if idx < mach.virtio_9p.mount_tag_len as usize {
                mach.virtio_9p.mount_tag[idx] as u32
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Write VirtIO 9p device-specific config (read-only from guest).
pub unsafe fn config_write(_offset: u16, _val: u32, _size: u8) {}

/// Handle queue notification — process 9p protocol messages.
pub unsafe fn queue_notify(queue_idx: u16) {
    if queue_idx != 0 {
        return;
    }
    process_9p_queue();
}

/// Process pending 9p requests from the guest.
unsafe fn process_9p_queue() {
    let mach = &mut *crate::exports::get_machine();
    let ram = mach.ram;
    let ram_size = mach.ram_size;
    let vq = &mut mach.virtio_9p.queues[0];

    if !vq.ready {
        return;
    }

    let mut processed = false;

    while let Some(desc_idx) = virtio::virtq_get_avail(ram, ram_size, vq) {
        // 9p uses a request/response pattern:
        // First descriptor(s) in chain: request (device-readable, no WRITE flag)
        // Last descriptor(s) in chain: response buffer (device-writable, WRITE flag)
        let mut req_addr = 0u64;
        let mut req_len = 0u32;
        let mut resp_addr = 0u64;
        let mut resp_len = 0u32;
        let mut idx = desc_idx;

        // Walk descriptor chain to find request and response buffers
        loop {
            let desc = virtio::virtq_read_desc(ram, ram_size, vq.desc_addr, idx);
            if desc.flags & 2 != 0 {
                // WRITE flag = response buffer
                if resp_addr == 0 {
                    resp_addr = desc.addr;
                    resp_len = desc.len;
                }
            } else {
                // No WRITE flag = request data
                if req_addr == 0 {
                    req_addr = desc.addr;
                    req_len = desc.len;
                }
            }
            if desc.flags & 1 != 0 {
                idx = desc.next;
            } else {
                break;
            }
        }

        let written = if req_len >= 7 && req_addr + req_len as u64 <= ram_size as u64
            && resp_addr + resp_len as u64 <= ram_size as u64
        {
            handle_9p_message(ram, ram_size, req_addr, req_len, resp_addr, resp_len)
        } else {
            0
        };

        virtio::virtq_put_used(ram, ram_size, vq, desc_idx, written);
        processed = true;
    }

    if processed {
        virtio::raise_irq(virtio::VIRTIO_DEV_9P);
    }
}

/// Handle a single 9p protocol message. Returns bytes written to response buffer.
unsafe fn handle_9p_message(
    ram: *mut u8,
    _ram_size: u32,
    req_addr: u64,
    req_len: u32,
    resp_addr: u64,
    resp_len: u32,
) -> u32 {
    let req = (ram as usize + req_addr as usize) as *const u8;
    let resp = (ram as usize + resp_addr as usize) as *mut u8;

    // 9p header: size[4] type[1] tag[2]
    let msg_type = *req.add(4);
    let tag_lo = *req.add(5);
    let tag_hi = *req.add(6);

    match msg_type {
        P9_TVERSION => {
            // Tversion: msize[4] version[s]
            // Respond with Rversion: msize[4] version[s]
            // Use the same msize the client proposed, version = "9P2000.L"
            let client_msize = if req_len >= 11 {
                u32::from_le_bytes([*req.add(7), *req.add(8), *req.add(9), *req.add(10)])
            } else {
                8192
            };
            let version = b"9P2000.L";
            let resp_size = 4 + 1 + 2 + 4 + 2 + version.len() as u32;
            if resp_len < resp_size {
                return write_rerror(resp, resp_len, tag_lo, tag_hi, 22); // EINVAL
            }
            write_u32_le(resp, resp_size);
            *resp.add(4) = P9_RVERSION;
            *resp.add(5) = tag_lo;
            *resp.add(6) = tag_hi;
            write_u32_le(resp.add(7), client_msize);
            write_u16_le(resp.add(11), version.len() as u16);
            core::ptr::copy_nonoverlapping(version.as_ptr(), resp.add(13), version.len());
            resp_size
        }
        P9_TATTACH => {
            // Tattach: fid[4] afid[4] uname[s] aname[s] n_uname[4]
            // Respond with Rattach: qid[13]
            let resp_size = 4 + 1 + 2 + 13; // header + qid
            if resp_len < resp_size {
                return write_rerror(resp, resp_len, tag_lo, tag_hi, 22);
            }
            write_u32_le(resp, resp_size);
            *resp.add(4) = P9_RATTACH;
            *resp.add(5) = tag_lo;
            *resp.add(6) = tag_hi;
            // QID: type=QTDIR(0x80), version=0, path=1
            *resp.add(7) = 0x80; // type = directory
            write_u32_le(resp.add(8), 0); // version
            write_u64_le(resp.add(12), 1); // path
            resp_size
        }
        _ => {
            // Unhandled message — respond with Rerror (ENOSYS = 38)
            write_rerror(resp, resp_len, tag_lo, tag_hi, 38)
        }
    }
}

/// Write a 9p Rerror response. Returns bytes written.
unsafe fn write_rerror(resp: *mut u8, resp_len: u32, tag_lo: u8, tag_hi: u8, errno: u32) -> u32 {
    // Rlerror: size[4] type[1] tag[2] ecode[4]
    let resp_size = 4 + 1 + 2 + 4;
    if resp_len < resp_size {
        return 0;
    }
    write_u32_le(resp, resp_size);
    *resp.add(4) = P9_RERROR;
    *resp.add(5) = tag_lo;
    *resp.add(6) = tag_hi;
    write_u32_le(resp.add(7), errno);
    resp_size
}

#[inline(always)]
unsafe fn write_u16_le(ptr: *mut u8, val: u16) {
    *ptr = val as u8;
    *ptr.add(1) = (val >> 8) as u8;
}

#[inline(always)]
unsafe fn write_u32_le(ptr: *mut u8, val: u32) {
    *ptr = val as u8;
    *ptr.add(1) = (val >> 8) as u8;
    *ptr.add(2) = (val >> 16) as u8;
    *ptr.add(3) = (val >> 24) as u8;
}

#[inline(always)]
unsafe fn write_u64_le(ptr: *mut u8, val: u64) {
    write_u32_le(ptr, val as u32);
    write_u32_le(ptr.add(4), (val >> 32) as u32);
}
