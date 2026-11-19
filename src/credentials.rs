use esp_storage::FlashStorage;

const PAGE_SIZE: usize = 4096;
const ITEM_SIZE: usize = 32;
const NVS_START: u32 = 0x9000;
const NVS_PAGES: u32 = 5;

pub struct Credentials {
    ssid: [u8; 36],
    password: [u8; 65],
}

impl Credentials {
    pub fn read(flash: &mut FlashStorage<'_>) -> Option<Self> {
        let mut namespace = None;
        scan(flash, |_, item, _| {
            if item[0] == 0 && item[1] == 1 && has_key(item, b"nvs.net80211") {
                namespace = Some(item[24]);
            }
        })?;
        let namespace = namespace?;
        Some(Self {
            ssid: read_blob(flash, namespace, b"sta.ssid")?,
            password: read_blob(flash, namespace, b"sta.pswd")?,
        })
    }

    pub fn ssid(&self) -> Option<&str> {
        let len = u32_at(&self.ssid, 0) as usize;
        if !(1..=32).contains(&len) {
            return None;
        }
        core::str::from_utf8(&self.ssid[4..4 + len]).ok()
    }

    pub fn password(&self) -> Option<&str> {
        let len = self.password.iter().position(|&byte| byte == 0)?;
        core::str::from_utf8(&self.password[..len]).ok()
    }
}

// These two small ESP-IDF Wi-Fi records each fit in one NVS blob chunk.
fn read_blob<const LEN: usize>(
    flash: &mut FlashStorage<'_>,
    namespace: u8,
    key: &[u8],
) -> Option<[u8; LEN]> {
    let mut index: Option<((u32, usize), u32, u8, u8)> = None;
    scan(flash, |position, item, _| {
        if item[0] == namespace
            && item[1] == 0x48
            && has_key(item, key)
            && index.is_none_or(|(previous, ..)| previous < position)
        {
            index = Some((position, u32_at(item, 24), item[28], item[29]));
        }
    })?;
    let (committed, size, chunks, chunk_id) = index?;
    if size as usize != LEN || chunks != 1 {
        return None;
    }

    let mut latest = None;
    let mut data = [0; LEN];
    scan(flash, |position, item, payload| {
        if item[0] != namespace || item[1] != 0x42 || item[3] != chunk_id || !has_key(item, key) {
            return;
        }
        let length = u16::from_le_bytes([item[24], item[25]]) as usize;
        if length != LEN
            || position >= committed
            || latest.is_some_and(|previous| previous > position)
        {
            return;
        }
        if let Some(blob) = payload.get(..length) {
            if crc32(blob.iter().copied()) == u32_at(item, 28) {
                data.copy_from_slice(blob);
                latest = Some(position);
            }
        }
    })?;
    latest.map(|_| data)
}

fn scan(
    flash: &mut FlashStorage<'_>,
    mut visit: impl FnMut((u32, usize), &[u8], &[u8]),
) -> Option<()> {
    #[repr(align(4))]
    struct AlignedPage([u8; PAGE_SIZE]);

    let mut buffer = AlignedPage([0; PAGE_SIZE]);
    let page = &mut buffer.0;
    for index in 0..NVS_PAGES {
        flash
            .read_nor(NVS_START + index * PAGE_SIZE as u32, page)
            .ok()?;
        if !matches!(u32_at(page, 0), 0xffff_fffe | 0xffff_fffc) {
            continue;
        }
        let sequence = u32_at(page, 4);
        let mut entry = 0;
        while entry < 126 {
            let state = (page[32 + entry / 4] >> (2 * (entry % 4))) & 3;
            if state != 2 {
                entry += 1;
                continue;
            }
            let start = 64 + entry * ITEM_SIZE;
            let item = &page[start..start + ITEM_SIZE];
            let span = item[2] as usize;
            if span == 0 || span > 126 - entry {
                break;
            }
            let bytes = item[..4].iter().chain(&item[8..]).copied();
            if crc32(bytes) == u32_at(item, 4) {
                visit(
                    (sequence, entry),
                    item,
                    &page[start + ITEM_SIZE..start + span * ITEM_SIZE],
                );
            }
            entry += span;
        }
    }
    Some(())
}

fn has_key(item: &[u8], key: &[u8]) -> bool {
    item[8..24].split(|&byte| byte == 0).next() == Some(key)
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn crc32(bytes: impl Iterator<Item = u8>) -> u32 {
    let mut crc = 0u32;
    for byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}
