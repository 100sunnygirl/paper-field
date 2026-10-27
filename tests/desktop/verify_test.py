"""Tests the verifier itself; this is not native desktop coverage."""
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest


class VerifierTest(unittest.TestCase):
    def test_accepts_persisted_data_and_rejects_corrupt_pdf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            library = root / "profile" / "library"
            library.mkdir(parents=True)
            shutil.copyfile(pathlib.Path(__file__).parent / "fixtures" / "smoke.pdf", root / "smoke.pdf")
            shutil.copyfile(root / "smoke.pdf", library / "copied.pdf")
            with sqlite3.connect(root / "profile" / "paper-field.db") as db:
                db.executescript("""
                    CREATE TABLE domains (id, name);
                    CREATE TABLE papers (id, domain_id, title, pdf_path);
                    CREATE TABLE notes (paper_id, kind, content, source);
                    INSERT INTO domains VALUES (1, 'Native smoke domain');
                    INSERT INTO papers VALUES (2, 1, 'smoke', 'library/copied.pdf');
                    INSERT INTO notes VALUES (2, 'summary',
                      'Native SQLite note survives a complete process restart.', 'manual');
                """)
            command = [sys.executable, str(pathlib.Path(__file__).with_name("verify.py")), str(root)]
            good = subprocess.run(command, capture_output=True)
            self.assertEqual(good.returncode, 0, good.stderr)
            (library / "copied.pdf").write_bytes(b"corrupt")
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
