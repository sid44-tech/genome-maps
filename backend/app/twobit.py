"""Minimal memory-mapped reader for UCSC .2bit reference genome files.

Only the requested byte range is touched, so reading a few kilobases from an
800 MB genome is effectively instant. Soft-masked (repeat) bases are returned
in lowercase, N blocks as 'N'.
"""

from __future__ import annotations

import mmap
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SIGNATURE = 0x1A412743
_BASES = np.frombuffer(b"TCAG", dtype=np.uint8)


@dataclass
class _SeqRecord:
    length: int
    n_starts: np.ndarray
    n_sizes: np.ndarray
    mask_starts: np.ndarray
    mask_sizes: np.ndarray
    dna_offset: int


class TwoBitFile:
    def __init__(self, path: str | Path):
        self._fh = open(path, "rb")
        self._mm = mmap.mmap(self._fh.fileno(), 0, access=mmap.ACCESS_READ)
        sig = struct.unpack_from("<I", self._mm, 0)[0]
        if sig == SIGNATURE:
            self._e = "<"
        elif struct.unpack_from(">I", self._mm, 0)[0] == SIGNATURE:
            self._e = ">"
        else:
            raise ValueError(f"{path} is not a .2bit file")
        version, count = struct.unpack_from(self._e + "II", self._mm, 4)
        offset_fmt = "Q" if version == 1 else "I"
        pos = 16
        self._offsets: dict[str, int] = {}
        for _ in range(count):
            name_len = self._mm[pos]
            name = self._mm[pos + 1 : pos + 1 + name_len].decode()
            pos += 1 + name_len
            (off,) = struct.unpack_from(self._e + offset_fmt, self._mm, pos)
            pos += struct.calcsize(offset_fmt)
            self._offsets[name] = off
        self._records: dict[str, _SeqRecord] = {}

    def _record(self, chrom: str) -> _SeqRecord:
        rec = self._records.get(chrom)
        if rec is not None:
            return rec
        if chrom not in self._offsets:
            raise KeyError(chrom)
        pos = self._offsets[chrom]
        u32 = np.dtype(self._e + "u4")

        def read_u32() -> int:
            nonlocal pos
            (v,) = struct.unpack_from(self._e + "I", self._mm, pos)
            pos += 4
            return v

        def read_arr(n: int) -> np.ndarray:
            nonlocal pos
            arr = np.frombuffer(self._mm, dtype=u32, count=n, offset=pos).astype(np.int64)
            pos += 4 * n
            return arr

        length = read_u32()
        n_count = read_u32()
        n_starts, n_sizes = read_arr(n_count), read_arr(n_count)
        m_count = read_u32()
        m_starts, m_sizes = read_arr(m_count), read_arr(m_count)
        pos += 4  # reserved
        rec = _SeqRecord(length, n_starts, n_sizes, m_starts, m_sizes, pos)
        self._records[chrom] = rec
        return rec

    def length(self, chrom: str) -> int:
        return self._record(chrom).length

    def fetch(self, chrom: str, start: int, end: int) -> str:
        rec = self._record(chrom)
        start, end = max(0, start), min(end, rec.length)
        if end <= start:
            return ""
        first_byte, last_byte = start // 4, (end - 1) // 4
        packed = np.frombuffer(
            self._mm, dtype=np.uint8, count=last_byte - first_byte + 1, offset=rec.dna_offset + first_byte
        )
        # Unpack 4 bases per byte, most significant bits first.
        codes = np.stack([(packed >> s) & 3 for s in (6, 4, 2, 0)], axis=1).reshape(-1)
        skip = start - first_byte * 4
        seq = _BASES[codes[skip : skip + (end - start)]].copy()
        _apply_blocks(seq, start, end, rec.n_starts, rec.n_sizes, lambda s: ord("N"))
        _apply_blocks(seq, start, end, rec.mask_starts, rec.mask_sizes, lambda s: s | 0x20, transform=True)
        return seq.tobytes().decode()

    def base_at(self, chrom: str, pos0: int) -> str:
        """Single uppercase reference base; a fast path for bulk lookups."""
        rec = self._record(chrom)
        if not 0 <= pos0 < rec.length:
            return "N"
        i = int(np.searchsorted(rec.n_starts, pos0, side="right")) - 1
        if i >= 0 and pos0 < rec.n_starts[i] + rec.n_sizes[i]:
            return "N"
        byte = self._mm[rec.dna_offset + pos0 // 4]
        return "TCAG"[(byte >> (6 - 2 * (pos0 % 4))) & 3]


def _apply_blocks(seq, start, end, starts, sizes, fn, transform=False):
    if len(starts) == 0:
        return
    # Blocks are sorted by start; find those overlapping [start, end).
    lo = max(0, np.searchsorted(starts, start, side="right") - 1)
    hi = np.searchsorted(starts, end, side="left")
    for bs, bz in zip(starts[lo:hi], sizes[lo:hi]):
        s, e = max(bs, start) - start, min(bs + bz, end) - start
        if e > s:
            seq[s:e] = fn(seq[s:e]) if transform else fn(None)
