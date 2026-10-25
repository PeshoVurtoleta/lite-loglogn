// LOGLOGN_SEED parser shared by the oracle tests. Fail closed: a SET but
// unparseable / non-integer / out-of-uint32 value throws; undefined -> fallback.
// Accepted: decimal digits only, or 0x + hex digits, value in [0, 2^32 - 1].
export function parseSeed(raw, fallback) {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*|0[xX][0-9a-fA-F]+)$/.test(raw)) {
        throw new RangeError('LOGLOGN_SEED=' + JSON.stringify(raw) + ' is not an integer in [0, 2^32 - 1]');
    }
    const v = Number(raw);
    if (!(v >= 0 && v <= 0xFFFFFFFF)) {
        throw new RangeError('LOGLOGN_SEED=' + JSON.stringify(raw) + ' is not an integer in [0, 2^32 - 1]');
    }
    return v >>> 0;
}
