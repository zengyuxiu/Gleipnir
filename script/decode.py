#!/usr/bin/env python3
"""Decode SSL-sniffed OpenClaw log lines into readable JSONL.

Usage:
  python3 script/decode.py --input logs/oc.log --output logs/oc.decoded.ndjson
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import zlib
from typing import Any


def fix_utf8_mojibake(raw: bytes) -> bytes:
    """Best-effort recovery for logs where bytes were UTF-8-expanded."""
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        return raw

    out = bytearray()
    for ch in text:
        cp = ord(ch)
        # U+0000..U+00FF likely came from byte->utf8 expansion, fold back to 1 byte.
        if cp <= 0xFF:
            out.append(cp)
        else:
            # Keep non-latin chars as original UTF-8 bytes.
            out.extend(ch.encode("utf-8"))
    return bytes(out)


def try_parse_json_text(payload: bytes) -> tuple[str | None, Any | None]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return None, None

    try:
        return text, json.loads(text)
    except json.JSONDecodeError:
        return text, None


def parse_ws_frame_at(buf: bytes, start: int = 0) -> tuple[dict[str, Any], int] | None:
    if len(buf) - start < 2:
        return None

    b0, b1 = buf[start], buf[start + 1]
    fin = (b0 >> 7) & 1
    rsv1 = (b0 >> 6) & 1
    rsv2 = (b0 >> 5) & 1
    rsv3 = (b0 >> 4) & 1
    opcode = b0 & 0x0F
    masked = (b1 >> 7) & 1
    payload_len = b1 & 0x7F

    if rsv2 or rsv3:
        return None
    if opcode not in {0x0, 0x1, 0x2, 0x8, 0x9, 0xA}:
        return None

    offset = start + 2
    if payload_len == 126:
        if len(buf) < offset + 2:
            return None
        payload_len = int.from_bytes(buf[offset : offset + 2], "big")
        offset += 2
    elif payload_len == 127:
        if len(buf) < offset + 8:
            return None
        payload_len = int.from_bytes(buf[offset : offset + 8], "big")
        offset += 8

    mask_key = b""
    if masked:
        if len(buf) < offset + 4:
            return None
        mask_key = buf[offset : offset + 4]
        offset += 4

    if len(buf) < offset + payload_len:
        return None

    payload = bytearray(buf[offset : offset + payload_len])
    if masked:
        for i in range(payload_len):
            payload[i] ^= mask_key[i % 4]

    opcode_name = {
        0x0: "continuation",
        0x1: "text",
        0x2: "binary",
        0x8: "close",
        0x9: "ping",
        0xA: "pong",
    }[opcode]

    out: dict[str, Any] = {
        "protocol": "websocket",
        "fin": bool(fin),
        "masked": bool(masked),
        "compressed": bool(rsv1),
        "opcode": opcode_name,
        "payload_len": payload_len,
    }

    payload_bytes = bytes(payload)
    decoded_payload = payload_bytes

    if rsv1 and opcode_name in {"text", "binary", "continuation"}:
        try:
            # permessage-deflate raw DEFLATE payload (tail required by zlib).
            decoded_payload = zlib.decompress(payload_bytes + b"\x00\x00\xff\xff", wbits=-15)
            out["inflated_len"] = len(decoded_payload)
        except zlib.error:
            out["inflate_error"] = True

    text, parsed_json = try_parse_json_text(decoded_payload)
    if text is None and decoded_payload is not payload_bytes:
        text, parsed_json = try_parse_json_text(payload_bytes)

    if text is not None:
        out["text"] = text
        if parsed_json is not None:
            out["json"] = parsed_json
    else:
        out["payload_hex"] = decoded_payload[:128].hex()

    consumed = offset + payload_len - start
    return out, consumed


def parse_ws_frames(buf: bytes, max_frames: int = 4) -> list[dict[str, Any]] | None:
    frames: list[dict[str, Any]] = []
    offset = 0

    while offset < len(buf) and len(frames) < max_frames:
        parsed = parse_ws_frame_at(buf, offset)
        if parsed is None:
            break
        frame, consumed = parsed
        if consumed <= 0:
            break
        frames.append(frame)
        offset += consumed

    if not frames:
        return None

    if offset < len(buf):
        frames[-1]["remaining_bytes"] = len(buf) - offset
    return frames


def ws_score(frames: list[dict[str, Any]]) -> int:
    score = 0
    for frame in frames:
        if "json" in frame:
            score += 10
        elif "text" in frame:
            score += 6
        elif frame.get("opcode") in {"ping", "pong", "close"}:
            score += 2
        else:
            score += 1
    return score


def try_gzip_text(data: bytes) -> str | None:
    idx = data.find(b"\x1f\x8b")
    if idx < 0:
        return None

    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data[idx:])) as gz:
            payload = gz.read()
        return payload.decode("utf-8", errors="replace")
    except (OSError, zlib.error, EOFError):
        return None


def safe_preview(data: bytes, max_chars: int = 220) -> str:
    txt = data.decode("utf-8", errors="replace")
    txt = txt.replace("\r", "\\r").replace("\n", "\\n")
    return txt[:max_chars]


def decode_ssl_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, str):
        return {"kind": "unknown", "raw_type": type(value).__name__}

    if not value.startswith("HEX:"):
        return {
            "kind": "plain_text",
            "text": value,
        }

    hex_part = value[4:]
    try:
        raw = bytes.fromhex(hex_part)
    except ValueError:
        return {
            "kind": "invalid_hex",
            "preview": value[:120],
        }

    fixed = fix_utf8_mojibake(raw)

    decoded: dict[str, Any] = {
        "kind": "hex",
        "raw_len": len(raw),
        "fixed_len": len(fixed),
        "preview": safe_preview(fixed),
    }

    fixed_frames = parse_ws_frames(fixed)
    raw_frames = parse_ws_frames(raw)

    picked_frames = None
    picked_from = None
    if fixed_frames and raw_frames:
        if ws_score(fixed_frames) >= ws_score(raw_frames):
            picked_frames = fixed_frames
            picked_from = "fixed"
        else:
            picked_frames = raw_frames
            picked_from = "raw"
    elif fixed_frames:
        picked_frames = fixed_frames
        picked_from = "fixed"
    elif raw_frames:
        picked_frames = raw_frames
        picked_from = "raw"

    if picked_frames is not None:
        decoded["frame"] = picked_frames[0]
        if len(picked_frames) > 1:
            decoded["frames"] = picked_frames
        decoded["frame_source"] = picked_from
        first = picked_frames[0]
        if "json" in first:
            decoded["preview"] = json.dumps(first["json"], ensure_ascii=False)[:220]
        elif "text" in first:
            decoded["preview"] = first["text"][:220]

    gz = try_gzip_text(fixed)
    if gz is None:
        gz = try_gzip_text(raw)
    if gz is not None:
        decoded["gzip_text_preview"] = gz[:500]

    return decoded


def decode_line(obj: dict[str, Any]) -> dict[str, Any]:
    out = {
        "timestamp": obj.get("timestamp"),
        "source": obj.get("source"),
        "pid": obj.get("pid"),
        "comm": obj.get("comm"),
    }

    if obj.get("source") == "ssl":
        d = obj.get("data", {})
        out["function"] = d.get("function")
        out["len"] = d.get("len")
        out["decoded"] = decode_ssl_payload(d.get("data"))
    elif obj.get("source") == "http_parser":
        d = obj.get("data", {})
        out["http"] = {
            "type": d.get("message_type"),
            "first_line": d.get("first_line"),
            "status_code": d.get("status_code"),
            "path": d.get("path"),
            "content_encoding": (d.get("headers") or {}).get("content-encoding"),
        }
    else:
        out["raw"] = obj.get("data")

    return out


def is_readable_event(event: dict[str, Any]) -> bool:
    if event.get("source") == "http_parser":
        return True
    if event.get("source") != "ssl":
        return False

    frame = (event.get("decoded") or {}).get("frame")
    if not isinstance(frame, dict):
        return False
    return ("text" in frame) or ("json" in frame)


def run(
    input_path: str,
    output_path: str | None,
    limit: int | None,
    readable_only: bool,
) -> None:
    out_f = open(output_path, "w", encoding="utf-8") if output_path else None

    count = 0
    with open(input_path, "r", encoding="utf-8", errors="replace") as f:
        for line_no, line in enumerate(f, start=1):
            if not line.strip():
                continue

            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            decoded = decode_line(obj)
            if readable_only and not is_readable_event(decoded):
                continue

            encoded = json.dumps(decoded, ensure_ascii=False)

            if out_f:
                out_f.write(encoded + "\n")
            else:
                print(encoded)

            count += 1
            if limit is not None and count >= limit:
                break

    if out_f:
        out_f.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Decode OpenClaw SSL logs")
    parser.add_argument("--input", default="logs/oc.log", help="input log path")
    parser.add_argument("--output", default="logs/oc.decoded.ndjson", help="output path")
    parser.add_argument("--limit", type=int, default=None, help="decode at most N lines")
    parser.add_argument(
        "--readable-only",
        action="store_true",
        help="only output readable events (http_parser + websocket text/json)",
    )
    args = parser.parse_args()

    run(args.input, args.output, args.limit, args.readable_only)


if __name__ == "__main__":
    main()
