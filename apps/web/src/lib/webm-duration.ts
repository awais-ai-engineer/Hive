/**
 * MediaRecorder writes WebM files without a Duration, so players show "live" timelines that keep
 * counting and cannot seek. This writes the measured duration into the Segment Info element.
 */

const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

function vintLength(first: number): number {
  for (let length = 1; length <= 8; length++) if (first & (0x80 >> (length - 1))) return length;
  return 0;
}

function readId(bytes: Uint8Array, at: number): { id: number; length: number } | null {
  const length = vintLength(bytes[at]);
  if (!length || length > 4 || at + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[at + i];
  return { id, length };
}

/** Size of -1 means "unknown", which MediaRecorder uses for the Segment. */
function readSize(bytes: Uint8Array, at: number): { size: number; length: number } | null {
  const length = vintLength(bytes[at]);
  if (!length || at + length > bytes.length) return null;
  let size = bytes[at] & (0xff >> length);
  let unknown = size === (0xff >> length);
  for (let i = 1; i < length; i++) { size = size * 256 + bytes[at + i]; unknown = unknown && bytes[at + i] === 0xff; }
  return { size: unknown ? -1 : size, length };
}

function encodeSize(size: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let value = size;
  for (let i = length - 1; i >= 0; i--) { out[i] = value % 256; value = Math.floor(value / 256); }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function readElements(bytes: Uint8Array, from: number, to: number) {
  const elements: { id: number; headerAt: number; dataAt: number; size: number; sizeLength: number }[] = [];
  let at = from;
  while (at < to) {
    const id = readId(bytes, at); if (!id) break;
    const size = readSize(bytes, at + id.length); if (!size) break;
    const dataAt = at + id.length + size.length;
    elements.push({ id: id.id, headerAt: at, dataAt, size: size.size, sizeLength: size.length });
    if (size.size < 0) break;
    at = dataAt + size.size;
  }
  return elements;
}

function float64(value: number): Uint8Array {
  const out = new Uint8Array(8); new DataView(out.buffer).setFloat64(0, value); return out;
}

export function patchWebmDuration(bytes: Uint8Array, durationMs: number): Uint8Array | null {
  const segment = readElements(bytes, 0, bytes.length).find(element => element.id === SEGMENT);
  if (!segment) return null;
  const segmentEnd = segment.size < 0 ? bytes.length : segment.dataAt + segment.size;
  const info = readElements(bytes, segment.dataAt, segmentEnd).find(element => element.id === INFO);
  if (!info || info.size < 0) return null;
  const children = readElements(bytes, info.dataAt, info.dataAt + info.size);
  let scale = 1_000_000;
  const scaleElement = children.find(element => element.id === TIMECODE_SCALE);
  if (scaleElement) { scale = 0; for (let i = 0; i < scaleElement.size; i++) scale = scale * 256 + bytes[scaleElement.dataAt + i]; }
  const ticks = (durationMs * 1_000_000) / scale;
  const existing = children.find(element => element.id === DURATION);
  if (existing) {
    const out = bytes.slice();
    const view = new DataView(out.buffer, out.byteOffset + existing.dataAt, existing.size);
    if (existing.size === 8) view.setFloat64(0, ticks); else if (existing.size === 4) view.setFloat32(0, ticks); else return null;
    return out;
  }
  // Insert a Duration element at the end of Info and grow the Info size (same byte length when it fits).
  const element = new Uint8Array([0x44, 0x89, 0x88, ...float64(ticks)]);
  const newInfoSize = info.size + element.length;
  const sizeLength = newInfoSize < 2 ** (7 * info.sizeLength) - 1 ? info.sizeLength : 8;
  const grown = sizeLength - info.sizeLength;
  const infoIdLength = info.dataAt - info.headerAt - info.sizeLength;
  const parts = [
    bytes.subarray(0, info.headerAt + infoIdLength),
    encodeSize(newInfoSize, sizeLength),
    bytes.subarray(info.dataAt, info.dataAt + info.size),
    element,
    bytes.subarray(info.dataAt + info.size),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  const segmentIdLength = segment.dataAt - segment.headerAt - segment.sizeLength;
  // A known Segment size lets players treat the file as complete rather than a live stream.
  const newSegmentSize = segment.size >= 0 ? segment.size + element.length + grown : out.length - segment.dataAt - grown;
  if (newSegmentSize < 2 ** (7 * segment.sizeLength) - 1) out.set(encodeSize(newSegmentSize, segment.sizeLength), segment.headerAt + segmentIdLength);
  else if (segment.size >= 0) return null;
  return out;
}

/** Returns the same file with a Duration written in, or the original when it is not WebM or cannot be patched. */
export async function withWebmDuration(file: File, durationMs: number): Promise<File> {
  if (!/webm/i.test(file.type)) return file;
  try {
    const patched = patchWebmDuration(new Uint8Array(await file.arrayBuffer()), durationMs);
    return patched ? new File([patched.buffer.slice(patched.byteOffset, patched.byteOffset + patched.byteLength) as ArrayBuffer], file.name, { type: file.type }) : file;
  } catch { return file; }
}
