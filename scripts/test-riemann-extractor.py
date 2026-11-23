#!/usr/bin/env python3
"""Parser regression tests and independent checks for the RH module index."""

from __future__ import annotations

import argparse
from collections import Counter, deque
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("extract-riemann-modules.py")


def reference_imports(text):
    """Independent line-oriented reference for ordinary snapshot headers.

    It does not import or reuse the production lexer. This pinned snapshot's
    actual headers use ordinary module names. Unsupported import syntax is a
    validation error rather than an invitation to omit an edge.
    """
    depth = 0
    active_import = False
    found = {}
    # Module names in this archive start with an uppercase ASCII letter.
    # The main extractor separately tests Lean's broader identifier syntax.
    module_name = re.compile(r"[A-Z][\w']*(?:\.[^\W\d][\w']*)*\Z")
    directive = re.compile(r"(?:(?:public|private|meta)\s+)*import(?:\s+all)?(?:\s|$)")
    for number, raw_line in enumerate(text.lstrip("\ufeff").splitlines(), 1):
        clean = []
        pos = 0
        while pos < len(raw_line):
            if raw_line.startswith("/-", pos):
                depth += 1
                clean.append(" ")
                pos += 2
            elif depth and raw_line.startswith("-/", pos):
                depth -= 1
                clean.append(" ")
                pos += 2
            elif depth:
                pos += 1
            elif raw_line.startswith("--", pos):
                break
            else:
                clean.append(raw_line[pos])
                pos += 1
        line = "".join(clean).strip()
        if not line:
            continue
        if line in {"module", "prelude"}:
            continue
        match = directive.match(line)
        if match:
            active_import = True
            rest = line[match.end():].strip()
            names = rest.split()
            if any(not module_name.fullmatch(name) for name in names):
                raise AssertionError(f"Unsupported reference import syntax on line {number}: {line}")
        elif active_import and all(module_name.fullmatch(name) for name in line.split()):
            names = line.split()
        else:
            if line.startswith("import"):
                raise AssertionError(f"Malformed reference import syntax on line {number}: {line}")
            return list(found.items())
        for name in names:
            found.setdefault(name, number)
    if depth:
        raise AssertionError("Unclosed comment in reference import header")
    return list(found.items())


def verify_index(index, source=None):
    """Check every serialized ID, edge, checksum, and optional source header."""
    index = Path(index)
    manifest = json.loads((index / "manifest.json").read_text())
    assert manifest["schema"] == "lean-module-index-v1"
    assert manifest["chunkSize"] == 512
    names = json.loads((index / manifest["namesFile"]).read_text())
    assert names == sorted(set(names)), "Names must be sorted and unique"
    assert len(names) == manifest["moduleCount"], "Module count mismatch"
    count = len(names)
    ids = {name: i for i, name in enumerate(names)}
    expected_files = {"names.json"} | {f"chunks/{chunk}.json" for chunk in range((count + 511) // 512)}
    assert set(manifest["files"]) == expected_files, "Incomplete output checksums"
    actual_files = {path.relative_to(index).as_posix() for path in index.rglob("*.json")} - {"manifest.json"}
    assert actual_files == expected_files, "Missing or stale index chunks"
    for relative, expected in manifest["files"].items():
        raw = (index / relative).read_bytes()
        assert len(raw) == expected["bytes"], f"Size mismatch: {relative}"
        assert hashlib.sha256(raw).hexdigest() == expected["sha256"], f"Checksum mismatch: {relative}"
    entries = []
    for chunk in range((count + 511) // 512):
        part = json.loads((index / f"chunks/{chunk}.json").read_text())
        assert len(part) == min(512, count - chunk * 512), f"Wrong chunk length: {chunk}"
        entries.extend(part)
    incoming = [[] for _ in names]
    total_internal = total_external = total_lines = 0
    externals = Counter()
    group_modules = Counter()
    group_lines = Counter()
    for source_id, entry in enumerate(entries):
        assert set(entry) == {"imports", "externalImports", "importedBy", "lines", "sha256"}
        assert type(entry["lines"]) is int and entry["lines"] >= 0
        assert re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
        targets = set()
        for target, line in entry["imports"]:
            assert type(target) is int and 0 <= target < count, f"Dangling edge at {names[source_id]}"
            assert target not in targets, f"Duplicate edge at {names[source_id]}"
            assert type(line) is int and 1 <= line <= entry["lines"], f"Invalid line at {names[source_id]}"
            assert target != source_id, f"Self import at {names[source_id]}"
            targets.add(target)
            incoming[target].append(source_id)
        targets = set()
        for target, line in entry["externalImports"]:
            assert target not in ids, f"Internal module labeled external: {target}"
            assert target not in targets, f"Duplicate external edge: {target}"
            assert type(line) is int and 1 <= line <= entry["lines"]
            targets.add(target)
            externals[target] += 1
        assert entry["importedBy"] == sorted(set(entry["importedBy"])), f"Unsorted or duplicated importedBy at {names[source_id]}"
        total_internal += len(entry["imports"])
        total_external += len(entry["externalImports"])
        total_lines += entry["lines"]
        group = names[source_id].split(".")[0]
        group_modules[group] += 1
        group_lines[group] += entry["lines"]
    for i, entry in enumerate(entries):
        assert incoming[i] == entry["importedBy"], f"Reciprocal edge mismatch: {names[i]}"
    assert total_internal == manifest["internalEdgeCount"]
    assert total_external == manifest["externalEdgeCount"]
    assert total_lines == manifest["totalLines"]
    assert [{"name": name, "modules": group_modules[name], "lines": group_lines[name]} for name in sorted(group_modules)] == manifest["groups"]
    assert [{"name": name, "importCount": externals[name]} for name in sorted(externals)] == manifest["externalModules"]
    # Traverse in the opposite direction from the production topological check.
    remaining = [len(edge) for edge in incoming]
    ready = deque(i for i, number in enumerate(remaining) if number == 0)
    visited = 0
    while ready:
        current = ready.popleft()
        visited += 1
        for target, _ in entries[current]["imports"]:
            remaining[target] -= 1
            if remaining[target] == 0:
                ready.append(target)
    assert visited == count, "Index has an import cycle"
    reachable = set()
    ready = deque([ids["Main"]] if "Main" in ids else [])
    while ready:
        current = ready.popleft()
        if current not in reachable:
            reachable.add(current)
            ready.extend(target for target, _ in entries[current]["imports"])
    graph = manifest["graph"]
    assert graph["acyclic"] is True
    assert graph["mainModuleId"] == ids.get("Main")
    assert graph["mainReachabilityIncludesRoot"] is True
    assert graph["topologicallyVisitedModuleCount"] == count
    assert graph["mainReachableModuleCount"] == len(reachable)
    assert graph["mainUnreachableModuleCount"] == count - len(reachable)
    assert graph["mainReachableInternalEdgeCount"] == sum(len(entries[i]["imports"]) for i in reachable)
    assert graph["mainReachableExternalEdgeCount"] == sum(len(entries[i]["externalImports"]) for i in reachable)
    if source is not None:
        source = Path(source).resolve()
        commit = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        assert commit == manifest["sourceCommit"], "Source revision mismatch"
        source_files = {path.relative_to(source / "src").as_posix()[:-5].replace("/", "."): path for path in (source / "src").rglob("*.lean")}
        assert set(source_files) == set(names), "Full source coverage mismatch"
        aggregate = hashlib.sha256()
        source_bytes = 0
        for i, name in enumerate(names):
            path = source_files[name]
            raw = path.read_bytes()
            sha = hashlib.sha256(raw).hexdigest()
            assert sha == entries[i]["sha256"], f"Source hash mismatch: {name}"
            assert len(raw.splitlines()) == entries[i]["lines"], f"Source line count mismatch: {name}"
            expected_imports = reference_imports(raw.decode("utf-8"))
            expected_internal = [[ids[target], line] for target, line in expected_imports if target in ids]
            expected_external = [[target, line] for target, line in expected_imports if target not in ids]
            assert entries[i]["imports"] == expected_internal, f"Source import mismatch: {name}"
            assert entries[i]["externalImports"] == expected_external, f"Source external import mismatch: {name}"
            aggregate.update(path.relative_to(source).as_posix().encode() + b"\0" + sha.encode() + b"\n")
            source_bytes += len(raw)
            if (i + 1) % 40000 == 0:
                print(f"Independently checked {i + 1:,}/{count:,} source headers and hashes", file=sys.stderr, flush=True)
        assert aggregate.hexdigest() == manifest["sourceFilesSha256"]
        assert source_bytes == manifest["totalSourceBytes"]
    summary = {"modules": count, "internalEdges": total_internal, "externalEdges": total_external,
               "lines": total_lines, "acyclic": True, "mainReachableModules": len(reachable),
               "mainUnreachableModules": count - len(reachable), "sourceHeadersVerified": source is not None,
               "dataFiles": len(expected_files), "dataFileBytes": sum(item["bytes"] for item in manifest["files"].values()),
               "sourceFilesSha256": manifest["sourceFilesSha256"]}
    return summary


def load_extractor():
    if not SCRIPT.is_file():
        raise AssertionError("The source-module extractor has not been implemented")
    spec = importlib.util.spec_from_file_location("riemann_extractor", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.extractor = load_extractor()

    def test_imports_and_first_occurrence_lines(self):
        text = "import Foo.Bar Mathlib\nimport Foo.Bar\ntheorem x : True := trivial\n"
        self.assertEqual(self.extractor.parse_imports(text), [("Foo.Bar", 1), ("Mathlib", 1)])

    def test_nested_comments_and_line_comments_are_not_imports(self):
        text = (
            "/- import Fake.One\n/- import Fake.Two -/\n-/\n"
            "-- import Fake.Three\nimport Real.One /- nested /- x -/ -/ Real.Two\n"
            'def text := "import Fake.Four"\n'
        )
        self.assertEqual(self.extractor.parse_imports(text), [("Real.One", 5), ("Real.Two", 5)])

    def test_multiline_imports_preserve_module_line_numbers(self):
        text = "import\n  Foo.A\n  /- a comment -/ Foo.B\nimport Foo.C\nopen Foo\n"
        self.assertEqual(self.extractor.parse_imports(text), [("Foo.A", 2), ("Foo.B", 3), ("Foo.C", 4)])

    def test_module_prelude_and_import_modifiers(self):
        text = "\ufeffmodule\nprelude\npublic import Foo\nmeta import Bar\nprivate theorem x : True := trivial\n"
        self.assertEqual(self.extractor.parse_imports(text), [("Foo", 3), ("Bar", 4)])

    def test_unicode_and_escaped_module_components(self):
        self.assertEqual(self.extractor.parse_imports("import Étale.α Foo.«theorem»\n"), [("Étale.α", 1), ("Foo.theorem", 1)])

    def test_source_without_imports(self):
        self.assertEqual(self.extractor.parse_imports('/- module docs -/\ndef s := "import Fake"\n'), [])

    def test_malformed_headers_fail_loudly(self):
        for text in ["import\n", "import Foo.\n", "import Foo, Bar\n", "/- missing close\nimport Hidden\n", "import «unfinished\n"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.extractor.parse_imports(text)


class ReferenceParserTests(unittest.TestCase):
    def test_unicode_subscripts_used_in_real_source_module_names(self):
        text = "import Development.AbelianVarietyTheory.PublishedTheorems.GaloisGeometry₂.AlgebraicCharacterWD\n"
        self.assertEqual(reference_imports(text), [("Development.AbelianVarietyTheory.PublishedTheorems.GaloisGeometry₂.AlgebraicCharacterWD", 1)])

    def test_body_comment_is_outside_the_import_header(self):
        text = 'import Main\ndef marker := "/-"\n'
        self.assertEqual(reference_imports(text), [("Main", 1)])


class ExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.extractor = load_extractor()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.output = self.root / "index"
        self.files = {
            "A.lean": "import Mathlib\ndef a := 1\n",
            "Group/B.lean": "import A\n",
            "Main.lean": "import A\nimport A\nimport Group.B\n",
            "Unused.lean": "def unused := 0\n",
        }
        for name, content in self.files.items():
            path = self.source / "src" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        self.git("init", "-q")
        self.git("add", "src")
        self.git("-c", "user.name=Extractor Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
        self.commit = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.source), *args], text=True, stderr=subprocess.STDOUT)

    def extract(self):
        return self.extractor.build_index(self.source, self.output, expected_commit=self.commit)

    def test_complete_graph_and_main_coverage(self):
        manifest = self.extract()
        self.assertEqual(json.loads((self.output / "names.json").read_text()), ["A", "Group.B", "Main", "Unused"])
        nodes = json.loads((self.output / "chunks/0.json").read_text())
        self.assertEqual(nodes[2]["imports"], [[0, 1], [1, 3]])
        self.assertEqual(nodes[0]["importedBy"], [1, 2])
        self.assertEqual(nodes[0]["externalImports"], [["Mathlib", 1]])
        self.assertEqual(nodes[0]["sha256"], hashlib.sha256(self.files["A.lean"].encode()).hexdigest())
        self.assertEqual((manifest["moduleCount"], manifest["internalEdgeCount"], manifest["externalEdgeCount"], manifest["totalLines"]), (4, 3, 1, 7))
        self.assertTrue(manifest["graph"]["acyclic"])
        self.assertEqual(manifest["graph"]["mainReachableModuleCount"], 3)
        self.assertEqual(manifest["graph"]["mainUnreachableModuleCount"], 1)
        self.assertEqual(manifest["extraction"]["duplicateImportsRemoved"], 1)
        independent = verify_index(self.output, self.source)
        self.assertEqual(independent["mainReachableModules"], 3)

    def test_output_is_byte_identical_when_repeated(self):
        self.extract()
        first = {p.relative_to(self.output).as_posix(): p.read_bytes() for p in self.output.rglob("*.json")}
        self.extract()
        second = {p.relative_to(self.output).as_posix(): p.read_bytes() for p in self.output.rglob("*.json")}
        self.assertEqual(first, second)

    def test_wrong_revision_rejected_before_writing(self):
        with self.assertRaisesRegex(ValueError, "revision"):
            self.extractor.build_index(self.source, self.output, expected_commit="0" * 40)
        self.assertFalse(self.output.exists())

    def test_changed_source_rejected_by_git_blob_hash(self):
        (self.source / "src/A.lean").write_text("import Mathlib\ndef a := 2\n")
        with self.assertRaisesRegex(ValueError, "content.*revision|blob"):
            self.extract()
        self.assertFalse(self.output.exists())

    def test_untracked_lean_source_rejected(self):
        (self.source / "src/Untracked.lean").write_text("import Mathlib\n")
        with self.assertRaisesRegex(ValueError, "untracked|coverage|source files"):
            self.extract()

    def test_unresolved_project_import_rejected(self):
        (self.source / "src/Main.lean").write_text("import Group.Missing\n")
        self.git("add", "src/Main.lean")
        self.git("-c", "user.name=Extractor Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "broken fixture")
        self.commit = self.git("rev-parse", "HEAD").strip()
        with self.assertRaisesRegex(ValueError, "unresolved project import.*Group.Missing"):
            self.extract()

    def test_unknown_external_namespace_rejected(self):
        (self.source / "src/Main.lean").write_text("import TypoNamespace.File\n")
        self.git("add", "src/Main.lean")
        self.git("-c", "user.name=Extractor Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "unknown fixture")
        self.commit = self.git("rev-parse", "HEAD").strip()
        with self.assertRaisesRegex(ValueError, "unrecognized external namespace.*TypoNamespace"):
            self.extract()


if __name__ == "__main__":
    if "--index" in sys.argv:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--index", type=Path, required=True)
        parser.add_argument("--source-dir", type=Path)
        args = parser.parse_args()
        print(json.dumps(verify_index(args.index, args.source_dir), indent=2))
    else:
        unittest.main(verbosity=2)
