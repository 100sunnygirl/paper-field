"""Read the real closed app's SQLite database and copied PDF, never seed state."""
from contextlib import closing
import hashlib
import pathlib
import sqlite3
import sys

root = pathlib.Path(sys.argv[1]).resolve()
profile = root / "profile"
# Connection.__exit__ ends a transaction; it does not close the file handle.
with closing(sqlite3.connect((profile / "paper-field.db").as_uri() + "?mode=ro", uri=True)) as db:
    rows = db.execute("""
        SELECT p.pdf_path, n.content, n.source
        FROM domains d JOIN papers p ON p.domain_id = d.id
        JOIN notes n ON n.paper_id = p.id
        WHERE d.name = ? AND p.title = ? AND n.kind = ?
    """, ("Native smoke domain", "smoke", "summary")).fetchall()
assert len(rows) == 1, f"Expected exactly one persisted paper/note, got {rows!r}"
stored, content, source = rows[0]
assert content == "Native SQLite note survives a complete process restart."
assert source == "manual"
assert stored.startswith("library/"), f"Expected portable library path: {stored}"
copied = (profile / stored).resolve()
assert copied.parent == (profile / "library").resolve(), "PDF escaped the isolated library"
assert hashlib.sha256(copied.read_bytes()).digest() == hashlib.sha256((root / "smoke.pdf").read_bytes()).digest()
print("Verified real SQLite domain/paper/note and byte-identical library PDF")
