//! Host wall clock: RFC 3339 UTC timestamps with millisecond precision, strictly increasing within a process and never
//! earlier than the latest timestamp already stored (seeded at start). Host time is never simulation or response time.

use std::time::{SystemTime, UNIX_EPOCH};

pub struct HostClock {
    last_ms: i64,
}

impl HostClock {
    pub fn new(floor_ms: i64) -> Self {
        Self { last_ms: floor_ms }
    }

    pub fn now_ms(&mut self) -> i64 {
        let system = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as i64).unwrap_or(0);
        self.last_ms = system.max(self.last_ms + 1);
        self.last_ms
    }

    pub fn now(&mut self) -> String {
        format_ms(self.now_ms())
    }

    pub fn last_ms(&self) -> i64 {
        self.last_ms
    }
}

/// Days since 1970-01-01 to a civil date (proleptic Gregorian), from Howard Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn format_ms(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rest / 3600, (rest % 3600) / 60, rest % 60)
}

/// Parses `YYYY-MM-DDTHH:MM:SS(.fff)Z` to milliseconds; other offsets and shapes return None.
pub fn parse_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || !text.ends_with('Z') || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':'
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let fraction = &text[19..text.len() - 1];
    let millis = if fraction.is_empty() {
        0
    } else {
        let digits = fraction.strip_prefix('.')?;
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let padded = format!("{digits:0<3}");
        padded[..3].parse::<i64>().ok()?
    };
    // days_from_civil
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000) + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_parses_round_trip() {
        for ms in [0_i64, 1_000, 951_782_400_000, 1_793_000_000_123, 4_102_444_800_999] {
            let text = format_ms(ms);
            assert_eq!(parse_ms(&text), Some(ms), "{text}");
        }
        assert_eq!(format_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(parse_ms("2026-10-26T10:00:00Z"), parse_ms("2026-10-26T10:00:00.000Z"));
        assert_eq!(parse_ms("2026-10-26T10:00:00+01:00"), None);
    }

    #[test]
    fn host_clock_is_strictly_increasing() {
        let mut clock = HostClock::new(i64::MAX / 4);
        let first = clock.now_ms();
        let second = clock.now_ms();
        assert!(second > first);
    }
}
