#!/usr/bin/env python3
"""Behavioral extraction regressions and independent source-evidence checks."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("extract-riemann-expansion.py")
DEFAULT_GRAPH = SCRIPT.parent.parent / "public/riemann-graph.json"
DEFAULT_DATA = SCRIPT.parent.parent / "public/riemann-expansion.json"


class ExpansionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()

    def fixture(self, files, seeds, edges=()):
        for path, text in files.items():
            dest = self.source / "src" / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, encoding="utf-8")
        for args in [("init", "-q"), ("add", "."),
                     ("-c", "user.name=Extractor Test", "-c", "user.email=test@example.invalid",
                      "commit", "-qm", "test source")]:
            subprocess.run(["git", "-C", str(self.source), *args], check=True, capture_output=True)
        self.commit = subprocess.check_output(["git", "-C", str(self.source), "rev-parse", "HEAD"], text=True).strip()
        nodes = []
        for node_id, name, module, line in seeds:
            nodes.append({"id": node_id, "declarationName": name, "module": module,
                          "evidence": [{"path": "src/" + module.replace(".", "/") + ".lean",
                                        "startLine": line, "endLine": line}]})
        self.graph = {"sourceCommit": self.commit, "sourceRepository": "test/source",
                      "nodes": nodes, "edges": list(edges)}
        self.graph_path = self.root / "overview.json"
        self.graph_path.write_text(json.dumps(self.graph))
        self.output = self.root / "expansion.json"

    def extract(self, expect_success=True, commit=None, env=None):
        proc = subprocess.run([sys.executable, str(SCRIPT), "--source", str(self.source),
                               "--overview", str(self.graph_path), "--output", str(self.output),
                               "--expected-commit", commit or self.commit, "--no-module-index"],
                              text=True, capture_output=True, env=env)
        if not expect_success:
            self.assertNotEqual(proc.returncode, 0, "Invalid source must be rejected")
            return proc
        self.assertEqual(proc.returncode, 0, f"Extraction failed:\n{proc.stdout}\n{proc.stderr}")
        return json.loads(self.output.read_text())

    def test_missing_rg_uses_portable_scan_with_identical_expansion(self):
        # Fails if candidate discovery requires rg or the fallback changes graph/evidence semantics.
        self.fixture({
            "A.lean": "namespace Ν\ndef «raw helper» : Nat := 1\n"
                      "@[simp] theorem helper₂ : Nat := «raw helper»\n"
                      "/-\ntheorem decoy : Nat := 99\n-/\nend Ν\n",
            "Main.lean": "import A\ndef root : Nat := Ν.helper₂\n",
        }, [("root", "root", "Main", 2)])
        expected = self.extract()
        git_only = self.root / "git-only-bin"
        git_only.mkdir()
        git_executable = shutil.which("git")
        self.assertIsNotNone(git_executable, "The source verifier requires Git")
        (git_only / "git").symlink_to(git_executable)
        env = dict(os.environ, PATH=str(git_only))
        self.assertIsNone(shutil.which("rg", path=env["PATH"]))
        self.output.unlink()
        actual = self.extract(env=env)
        self.assertEqual({node["id"]: node["revealTier"] for node in actual["nodes"]},
                         {"decl:Ν.helper₂": 1, "decl:Ν.«raw helper»": 2})
        self.assertEqual(actual, expected)

    def test_nested_comments_strings_and_next_declaration_do_not_create_edges(self):
        # Fails if tokenization accepts comments/strings or crosses a declaration boundary.
        self.fixture({
            "A.lean": "namespace N\ndef leaf : Nat := 1\ndef middle : Nat := leaf\ndef decoy : Nat := 2\nend N\n",
            "Main.lean": 'import A\nnamespace N\nsection S\ntheorem root : Nat := by\n'
                         '  let s := "decoy N.decoy \\\"still a string\\\""\n'
                         '  /- decoy /- N.decoy -/ decoy -/\n'
                         '  exact middle -- decoy\nend S\nend N\n'
                         'theorem distractor : Nat := N.decoy\n',
        }, [("root", "N.root", "Main", 4)])
        data = self.extract()
        self.assertEqual({n["id"]: n["revealTier"] for n in data["nodes"]},
                         {"decl:N.middle": 1, "decl:N.leaf": 2})
        self.assertEqual({(e["from"], e["to"], e["revealTier"]) for e in data["edges"]},
                         {("decl:N.middle", "root", 1), ("decl:N.leaf", "decl:N.middle", 2)})
        self.assertEqual(data["edges"][0]["evidence"][0]["startLine"], 7)

    def test_open_namespace_ambiguity_and_unimported_symbols_are_not_guessed(self):
        # Fails if a globally unique suffix or an arbitrary open namespace wins.
        self.fixture({
            "A.lean": "namespace Left\ndef pick : Nat := 1\ndef unique : Nat := 2\nend Left\n",
            "B.lean": "namespace Right\ndef pick : Nat := 3\nend Right\n",
            "Outside.lean": "namespace Left\ndef unique : Nat := 99\nend Left\n",
            "Main.lean": "import A B\nsection Scoped\nopen Left Right\ndef root : Nat := pick + Left.unique\nend Scoped\ndef root2 : Nat := unique\n",
        }, [("root", "root", "Main", 4), ("root2", "root2", "Main", 6)])
        data = self.extract()
        self.assertEqual([n["declarationName"] for n in data["nodes"]], ["Left.unique"])
        self.assertEqual([(e["from"], e["to"]) for e in data["edges"]], [("decl:Left.unique", "root")])
        counts = data["coverage"]["referenceOutcomes"]
        self.assertGreaterEqual(counts.get("ambiguous", 0), 1)
        self.assertGreaterEqual(counts.get("unresolved", 0), 1)

    def test_external_and_unknown_names_are_recorded_without_candidates(self):
        # Fails if a token absent from the project declaration index crashes or fabricates a node.
        self.fixture({"Main.lean": "import Mathlib\ndef root : UnknownType := External.value\n"},
                     [("root", "root", "Main", 2)])
        data = self.extract()
        self.assertEqual(data["nodes"], [])
        self.assertEqual(data["edges"], [])
        self.assertEqual(data["coverage"]["referenceOutcomes"].get("unresolved"), 2)

    def test_private_declarations_and_local_binders_shadow_global_names(self):
        # Fails if a local variable or private source alias is treated as a public declaration.
        self.fixture({
            "A.lean": "namespace N\ndef leaf : Nat := 1\ndef middle : Nat := leaf\ndef secret : Nat := 2\nend N\n",
            "Main.lean": "import A\nnamespace N\nprivate def secret : Nat := 3\n"
                         "def root (leaf : Nat) : Nat := by\n  let middle := leaf\n  exact middle + secret\nend N\n",
        }, [("root", "N.root", "Main", 4)])
        data = self.extract()
        self.assertEqual(data["nodes"], [])
        self.assertEqual(data["edges"], [])
        self.assertGreaterEqual(data["coverage"]["referenceOutcomes"].get("private", 0), 1)

    def test_pattern_and_choice_binders_do_not_become_global_references(self):
        # Fails if tactic-pattern variables are mistaken for same-namespace declarations.
        self.fixture({
            "A.lean": "namespace N\ndef chosen : Nat := 1\ndef component : Nat := 2\ndef branch : Nat := 3\nend N\n",
            "Main.lean": "import A\nnamespace N\ndef root : Nat := by\n"
                         "  choose chosen h using someExternalFact\n  rintro ⟨component, hc⟩\n"
                         "  cases unknown with\n  | mk branch => exact chosen + component + branch\nend N\n",
        }, [("root", "N.root", "Main", 3)])
        data = self.extract()
        self.assertEqual(data["nodes"], [])
        self.assertEqual(data["edges"], [])

    def test_modified_declaration_keeps_its_indented_body(self):
        # Fails if modifiers are counted as indentation and truncate the declaration at an inner open.
        self.fixture({
            "A.lean": "namespace N\ndef helper : Nat := 1\nend N\n",
            "Main.lean": "import A\nnoncomputable def root : Nat := by\n  open N in\n  exact N.helper\n",
        }, [("root", "root", "Main", 2)])
        data = self.extract()
        self.assertEqual([n["id"] for n in data["nodes"]], ["decl:N.helper"])
        self.assertEqual(data["edges"][0]["evidence"][0]["startLine"], 4)

    def test_two_round_limit_shared_owners_and_existing_ids(self):
        # Fails if an overview declaration is cloned, a shared node duplicates, or depth leaks.
        self.fixture({
            "A.lean": "def beyond : Nat := 0\ndef last : Nat := beyond\ndef shared : Nat := last\n",
            "Main.lean": "import A\ndef existing : Nat := 10\ndef root : Nat := existing + shared\ndef root2 : Nat := shared\n",
        }, [("root", "root", "Main", 3), ("root2", "root2", "Main", 4),
            ("original-existing", "existing", "Main", 2)],
            [{"from": "original-existing", "to": "root", "kind": "proof-reference"}])
        data = self.extract()
        nodes = {n["id"]: n for n in data["nodes"]}
        self.assertEqual(set(nodes), {"decl:shared", "decl:last"})
        self.assertEqual(nodes["decl:shared"]["revealTier"], 1)
        self.assertEqual(nodes["decl:last"]["revealTier"], 2)
        self.assertEqual(nodes["decl:shared"]["overviewIds"], ["root", "root2"])
        self.assertEqual(nodes["decl:last"]["overviewIds"], ["root", "root2"])
        self.assertEqual(nodes["decl:last"]["ownerId"], "root")
        self.assertEqual(nodes["decl:last"]["boundary"]["reason"], "depth-limit")
        self.assertNotIn(("original-existing", "root"), {(e["from"], e["to"]) for e in data["edges"]})

    def test_namespace_priority_root_qualification_and_local_open(self):
        # Fails if namespace nesting or a command-local open leaks into the next declaration.
        self.fixture({
            "A.lean": "def pick : Nat := 0\nnamespace N\ndef pick : Nat := 1\nnamespace Sub\ndef deep : Nat := 2\nend Sub\nend N\n",
            "Main.lean": "import A\nnamespace N\nopen Sub in\ndef root : Nat := pick + _root_.pick + deep\ndef root2 : Nat := deep\nend N\n",
        }, [("root", "N.root", "Main", 4), ("root2", "N.root2", "Main", 5)])
        data = self.extract()
        self.assertEqual({n["id"] for n in data["nodes"]}, {"decl:N.pick", "decl:pick", "decl:N.Sub.deep"})
        self.assertTrue(all(e["to"] == "root" for e in data["edges"]))

    def test_structure_field_labels_are_not_references_but_field_types_are(self):
        # Fails if declaration field names are resolved as unrelated global declarations.
        self.fixture({
            "A.lean": "def helper : Nat := 1\ndef build : Nat := 2\ndef FieldType := Nat\n"
                      "structure Packet where\n  helper : Nat\n  build (x : Nat) : Nat\n  value : FieldType\n",
            "Main.lean": "import A\ndef root : Packet := unspecified\n",
        }, [("root", "root", "Main", 2)])
        data = self.extract()
        self.assertEqual({n["id"]: n["revealTier"] for n in data["nodes"]},
                         {"decl:Packet": 1, "decl:FieldType": 2})
        self.assertEqual({(e["from"], e["to"]) for e in data["edges"]},
                         {("decl:Packet", "root"), ("decl:FieldType", "decl:Packet")})
        report = next(c for c in data["coverage"]["consumers"] if c["id"] == "decl:Packet")
        self.assertGreaterEqual(report["referenceOutcomes"].get("field-binder", 0), 3)

    def test_partially_resolved_declaration_remains_an_expansion_boundary(self):
        # Fails if one resolved reference is mistaken for complete source coverage.
        self.fixture({
            "A.lean": "def leaf : Nat := 1\ndef middle : Nat := leaf + External.unknown\n",
            "Main.lean": "import A\ndef root : Nat := middle\n",
        }, [("root", "root", "Main", 2)])
        data = self.extract()
        middle = next(node for node in data["nodes"] if node["id"] == "decl:middle")
        self.assertTrue(middle["boundary"]["isBoundary"])
        self.assertEqual(middle["boundary"]["reason"], "static-resolution-limit")
        self.assertEqual(middle["boundary"]["unexpandedReferenceCount"], 1)
        self.assertIn(("decl:leaf", "decl:middle"), {(edge["from"], edge["to"]) for edge in data["edges"]})

    def test_mutual_blocks_do_not_pop_enclosing_namespace(self):
        # Fails if an end belonging to mutual closes the containing namespace instead.
        self.fixture({
            "A.lean": "namespace N\nmutual\ndef mutualOne : Nat := 0\ndef mutualTwo : Nat := 1\nend\ndef after : Nat := mutualOne\nend N\n",
            "Main.lean": "import A\ndef root : Nat := N.after\n",
        }, [("root", "root", "Main", 2)])
        data = self.extract()
        self.assertEqual({n["id"]: n["revealTier"] for n in data["nodes"]},
                         {"decl:N.after": 1, "decl:N.mutualOne": 2})

    def test_referenced_evidence_is_precise_and_output_is_deterministic(self):
        # Fails if source lines/hashes are fabricated or iteration order changes serialization.
        self.fixture({"A.lean": "def helper : Nat := 1\n",
                      "Main.lean": "import A\ndef root : Nat :=\n  helper + helper\n"},
                     [("root", "root", "Main", 2)])
        data = self.extract()
        before = self.output.read_bytes()
        self.extract()
        self.assertEqual(before, self.output.read_bytes())
        self.assertEqual(data["nodes"][0]["evidence"][0]["startLine"], 1)
        evidence = data["edges"][0]["evidence"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["startLine"], 3)
        self.assertEqual(evidence[0]["endLine"], 3)
        self.assertEqual(evidence[0]["token"], "helper")
        self.assertEqual(evidence[0]["sha256"], hashlib.sha256((self.source / "src/Main.lean").read_bytes()).hexdigest())
        verify_expansion(self.output, self.graph_path, self.source)

    def test_rejects_modified_source_and_revision_mismatch_without_overwriting(self):
        # Fails if source evidence is accepted from uncommitted bytes or a different revision.
        self.fixture({"A.lean": "def helper : Nat := 1\n", "Main.lean": "import A\ndef root : Nat := helper\n"},
                     [("root", "root", "Main", 2)])
        self.extract()
        before = self.output.read_bytes()
        mismatch = self.extract(False, commit="0" * 40)
        self.assertIn("revision mismatch", mismatch.stderr.lower())
        (self.source / "src/A.lean").write_text("def helper : Nat := 99\n")
        changed = self.extract(False)
        self.assertIn("blob", changed.stderr.lower())
        self.assertEqual(before, self.output.read_bytes())


def verify_expansion(data_path, overview_path, source=None):
    """Independently verify serialized topology, evidence bytes and declaration locations."""
    data = json.loads(Path(data_path).read_text())
    overview = json.loads(Path(overview_path).read_text())
    assert data["schema"] == "riemann-source-expansion-v1"
    assert data["sourceCommit"] == overview["sourceCommit"]
    original = {node["id"]: node for node in overview["nodes"]}
    new = {node["id"]: node for node in data["nodes"]}
    assert len(new) == len(data["nodes"]), "Duplicate declaration IDs"
    assert not set(original) & set(new), "Expansion duplicates an overview ID"
    all_nodes = {**original, **new}
    names = {node["declarationName"] for node in original.values()}
    original_pairs = {(edge["from"], edge["to"]) for edge in overview["edges"]}
    pairs = set()
    cached = {}
    tracked = {}
    if source is not None:
        source = Path(source)
        commit = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        assert commit == data["sourceCommit"], "Source revision mismatch"
        tree = subprocess.check_output(["git", "-C", str(source), "ls-tree", "-r", "-z", "HEAD", "--", "src"])
        for entry in tree.split(b"\0"):
            if entry:
                metadata, path = entry.split(b"\t", 1)
                tracked[path.decode()] = metadata.decode().split()[2]

    def evidence_file(evidence):
        path = evidence["path"]
        assert path.startswith("src/") and ".." not in Path(path).parts
        assert isinstance(evidence["startLine"], int) and 1 <= evidence["startLine"] <= evidence["endLine"]
        assert re.fullmatch(r"[0-9a-f]{64}", evidence["sha256"])
        expected_url = f"https://github.com/{data['sourceRepository']}/blob/{data['sourceCommit']}/{path}#L{evidence['startLine']}"
        assert evidence["url"].startswith(expected_url), "Evidence URL does not pin the source location"
        if source is None:
            return None
        if path not in cached:
            raw = (source / path).read_bytes()
            blob = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
            assert tracked.get(path) == blob, f"Source blob mismatch: {path}"
            cached[path] = (hashlib.sha256(raw).hexdigest(), raw.decode().splitlines())
        digest, lines = cached[path]
        assert digest == evidence["sha256"], f"Source SHA-256 mismatch: {path}"
        assert evidence["endLine"] <= len(lines), f"Evidence outside source: {path}"
        return lines[evidence["startLine"] - 1:evidence["endLine"]]

    for node in new.values():
        assert node["id"] == "decl:" + node["declarationName"]
        assert node["declarationName"] not in names, "Overview declaration cloned under a new ID"
        names.add(node["declarationName"])
        assert node["ownerId"] in original and node["ownerId"] in node["overviewIds"]
        assert node["overviewIds"] and set(node["overviewIds"]) <= set(original)
        assert node["revealTier"] in (1, 2) and node["status"] == "source"
        assert node["boundary"]["mathematicalAxiom"] is False
        assert node["evidence"], "New node lacks evidence"
        for evidence in node["evidence"]:
            lines = evidence_file(evidence)
            if lines is not None:
                assert re.search(r"\b(theorem|lemma|def|abbrev|axiom|opaque|constant|structure|class|inductive|instance)\b", lines[0]), "Node evidence does not begin at a declaration"
                assert node["label"] in lines[0], f"Declaration name absent at {evidence['path']}:{evidence['startLine']}"
    consumers = Counter()
    for edge in data["edges"]:
        pair = (edge["from"], edge["to"])
        assert pair not in pairs and pair not in original_pairs, "Repeated edge"
        pairs.add(pair)
        assert pair[0] in all_nodes and pair[1] in all_nodes, "Dangling edge"
        assert pair[0] != pair[1], "Self reference"
        assert edge["kind"] == "source-reference"
        assert edge["dependencySemantics"] == "explicit resolved source reference, not elaborated proof-term dependency"
        assert edge["revealTier"] in (1, 2)
        assert edge["revealTier"] >= max(all_nodes[pair[0]].get("revealTier", 0), all_nodes[pair[1]].get("revealTier", 0))
        consumers[pair[0]] += 1
        consumer = all_nodes[pair[1]]
        for evidence in edge["evidence"]:
            assert evidence["startLine"] == evidence["endLine"], "Reference evidence must identify a specific line"
            assert evidence["path"] == consumer["evidence"][0]["path"], "Reference comes from another declaration's file"
            assert consumer["evidence"][0]["startLine"] <= evidence["startLine"]
            # Overview spans were independently curated; extracted spans may include a header continuation.
            if pair[1] in new:
                assert evidence["endLine"] <= consumer["evidence"][0]["endLine"]
            lines = evidence_file(evidence)
            if lines is not None:
                assert evidence["token"] in lines[0], f"Referenced token absent: {evidence}"
            assert evidence["resolvedDeclaration"] == all_nodes[pair[0]]["declarationName"]
    assert set(new) <= set(consumers), "Unconnected expansion node"
    result = {"newNodes": len(new), "newEdges": len(pairs),
              "tier1NewNodes": sum(n["revealTier"] == 1 for n in new.values()),
              "tier2NewNodes": sum(n["revealTier"] == 2 for n in new.values()),
              "verifiedSourceFiles": len(cached),
              "sha256": hashlib.sha256(Path(data_path).read_bytes()).hexdigest()}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path)
    parser.add_argument("--overview", type=Path, default=DEFAULT_GRAPH)
    parser.add_argument("--source", type=Path)
    args, remaining = parser.parse_known_args()
    if args.data:
        print(json.dumps(verify_expansion(args.data, args.overview, args.source), ensure_ascii=False, indent=2))
    else:
        unittest.main(argv=[sys.argv[0], *remaining])
