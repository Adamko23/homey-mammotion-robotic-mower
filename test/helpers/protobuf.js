"use strict";

// Independent wire decoder for testing the bytes sent to the mower.
function decode(buffer) {
  let offset = 0;
  const fields = new Map();
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    while (offset < buffer.length) {
      const byte = buffer[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
      shift += 7n;
    }
    throw new Error("Truncated varint");
  };
  while (offset < buffer.length) {
    const key = Number(varint());
    const wireType = key & 7;
    let value;
    if (wireType === 0) value = varint();
    else if (wireType === 1) { value = buffer.readBigUInt64LE(offset); offset += 8; }
    else if (wireType === 2) { const length = Number(varint()); value = buffer.subarray(offset, offset + length); offset += length; }
    else if (wireType === 5) { value = buffer.readFloatLE(offset); offset += 4; }
    else throw new Error(`Unsupported wire type ${wireType}`);
    const field = key >> 3;
    fields.set(field, [...(fields.get(field) || []), value]);
  }
  return fields;
}

module.exports = { decode };
