#!/usr/bin/env python3
"""Extract all explicit src/**/*.lean imports from a verified Git revision.

This is a source-module index, not a declaration dependency closure or a Lean
verification run. Only Python's standard library and read-only Git commands
are used. Every input byte is checked against its committed Git blob before
any output is written. Names and IDs are stable for the pinned source tree.
"""

from __future__ import annotations

import argparse
from collections import Counter, deque
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


SOURCE_COMMIT = "7cbf7a0c32fca1badf05931879a37c3f8a2b03b4"
SOURCE_REPOSITORY = "CocoSgt/riemann-hypothesis-lean"
GENERATED_AT = "2026-11-23T00:00:00Z"
CHUNK_SIZE = 512
EXTERNAL_ROOTS = frozenset({
    "Aesop", "Batteries", "Cli", "ImportGraph", "Init", "Lean", "Mathlib",
    "Plausible", "ProofWidgets", "Qq", "Std",
})
# These keywords terminate Lean's import header. Unexpected bare names are
# deliberately retained as imports and must resolve, rather than silently
# truncating a header. Escaped identifiers are never treated as keywords.
COMMAND_KEYWORDS = frozenset("""
abbrev alias attribute axiom axioms builtin_initialize class coinductive
declare_syntax_cat def deriving elab elab_rules end example export include
inductive infix infixl infixr initialize instance lemma local macro macro_rules
mutual namespace noncomputable notation omit opaque open postfix prefix
protected register_builtin_option register_option run_cmd run_elab section
set_option structure syntax theorem universe universes variable variables
where with
""".split())
HEADER_KEYWORDS = frozenset({"import", "public", "private", "meta", "module", "prelude", "all"})
WHITESPACE = re.compile(r"\s+")
COMMENT_MARKERS = re.compile(r"/-|-/")


@dataclass(frozen=True)
class Token:
    value: str
    line: int
    kind: str


class HeaderLexer:
    """Lazy lexer: no arbitrary byte/line cap, and nested Lean comments work."""

    def __init__(self, text: str, source: str):
        self.text = text
        self.source = source
        self.pos = 1 if text.startswith("\ufeff") else 0
        self.line = 1
        self.lookahead = None

    def error(self, message: str):
        raise ValueError(f"{self.source}:{self.line}: {message}")

    def skip_space_and_comments(self):
        while self.pos < len(self.text):
            match = WHITESPACE.match(self.text, self.pos)
            if match:
                self.line += match[0].count("\n")
                self.pos = match.end()
                continue
            if self.text.startswith("--", self.pos):
                end = self.text.find("\n", self.pos + 2)
                self.pos = len(self.text) if end == -1 else end
                continue
            if self.text.startswith("/-", self.pos):
                depth = 1
                start_line = self.line
                self.pos += 2
                while depth:
                    marker = COMMENT_MARKERS.search(self.text, self.pos)
                    if marker is None:
                        self.error(f"unterminated header comment beginning on line {start_line}")
                    self.line += self.text[self.pos:marker.start()].count("\n")
                    self.pos = marker.end()
                    depth += 1 if marker[0] == "/-" else -1
                continue
            break

    def scan(self) -> Token:
        self.skip_space_and_comments()
        if self.pos == len(self.text):
            return Token("", self.line, "eof")
        line = self.line
        ch = self.text[self.pos]
        if not (ch.isalpha() or ch == "_" or ch == "«"):
            self.pos += 1
            return Token(ch, line, "punctuation")
        parts = []
        escaped = False
        while True:
            if self.pos < len(self.text) and self.text[self.pos] == "«":
                escaped = True
                end = self.text.find("»", self.pos + 1)
                if end == -1 or "\n" in self.text[self.pos:end]:
                    self.error("unterminated escaped module identifier")
                part = self.text[self.pos + 1:end]
                if not part:
                    self.error("empty escaped module identifier")
                self.pos = end + 1
            else:
                if self.pos >= len(self.text) or not (self.text[self.pos].isalpha() or self.text[self.pos] == "_"):
                    self.error("module name has an empty or invalid component")
                start = self.pos
                self.pos += 1
                while self.pos < len(self.text) and (self.text[self.pos].isalnum() or self.text[self.pos] in "_'"):
                    self.pos += 1
                part = self.text[start:self.pos]
            parts.append(part)
            if self.pos >= len(self.text) or self.text[self.pos] != ".":
                break
            self.pos += 1
        value = ".".join(parts)
        kind = "keyword" if not escaped and value in COMMAND_KEYWORDS | HEADER_KEYWORDS else "name"
        return Token(value, line, kind)

    def peek(self) -> Token:
        if self.lookahead is None:
            self.lookahead = self.scan()
        return self.lookahead

    def take(self) -> Token:
        result = self.peek()
        self.lookahead = None
        return result


def parse_header(text: str, source: str = "<text>") -> dict:
    lexer = HeaderLexer(text, source)
    imports = []
    commands = 0
    multiline_commands = 0
    prelude = False
    while True:
        token = lexer.peek()
        if token.kind == "keyword" and token.value in {"module", "prelude"}:
            prelude = prelude or token.value == "prelude"
            lexer.take()
            continue
        while token.kind == "keyword" and token.value in {"public", "private", "meta"}:
            lexer.take()
            token = lexer.peek()
        if token.kind != "keyword" or token.value != "import":
            break
        command_line = lexer.take().line
        commands += 1
        if lexer.peek().kind == "keyword" and lexer.peek().value == "all":
            lexer.take()
        names_in_command = 0
        multiline = False
        last_line = command_line
        while lexer.peek().kind == "name":
            name = lexer.take()
            imports.append((name.value, name.line))
            names_in_command += 1
            multiline = multiline or name.line != command_line
            last_line = name.line
        if not names_in_command:
            raise ValueError(f"{source}:{command_line}: import has no module name")
        token = lexer.peek()
        if token.kind == "punctuation" and (token.line == last_line or token.value not in {"#", "@"}):
            raise ValueError(f"{source}:{token.line}: unsupported or malformed import header near {token.value!r}")
        multiline_commands += int(multiline)
    unique = {}
    for name, line in imports:
        unique.setdefault(name, line)
    return {
        "imports": list(unique.items()),
        "duplicateImportsRemoved": len(imports) - len(unique),
        "importCommandCount": commands,
        "multilineImportCommandCount": multiline_commands,
        "prelude": prelude,
    }


def parse_imports(text: str, source: str = "<text>") -> list[tuple[str, int]]:
    return parse_header(text, source)["imports"]


def git(source: Path, *args: str) -> bytes:
    try:
        return subprocess.check_output(["git", "-C", str(source), *args], stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"Git input verification failed: {exc.stderr.decode('utf-8', 'replace').strip()}") from exc


def source_inventory(source: Path, expected_commit: str):
    actual = git(source, "rev-parse", "HEAD").decode().strip()
    if actual != expected_commit:
        raise ValueError(f"source revision mismatch: expected {expected_commit}, found {actual}")
    object_format = git(source, "rev-parse", "--show-object-format").decode().strip()
    if object_format not in {"sha1", "sha256"}:
        raise ValueError(f"unsupported Git object format: {object_format}")
    tracked = {}
    tree = git(source, "ls-tree", "-r", "-z", "HEAD", "--", "src")
    for entry in tree.split(b"\0"):
        if not entry:
            continue
        metadata, path_bytes = entry.split(b"\t", 1)
        path = path_bytes.decode("utf-8")
        if not path.endswith(".lean"):
            continue
        mode, kind, oid = metadata.decode().split()
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise ValueError(f"unsupported source file type: {path}")
        tracked[path] = oid
    if not tracked:
        raise ValueError("the source revision contains no src/**/*.lean files")
    found = {path.relative_to(source).as_posix() for path in (source / "src").rglob("*.lean")}
    if found != set(tracked):
        missing = sorted(set(tracked) - found)
        extra = sorted(found - set(tracked))
        raise ValueError(f"source files do not match revision coverage: missing={missing[:5]}, untracked={extra[:5]}")
    names_to_paths = {}
    for path in tracked:
        name = path[len("src/"):-len(".lean")].replace("/", ".")
        if name in names_to_paths:
            raise ValueError(f"module-name collision: {name}")
        names_to_paths[name] = path
    tree_oid = git(source, "rev-parse", f"{expected_commit}:src").decode().strip()
    return tracked, names_to_paths, object_format, tree_oid


def graph_statistics(names: list[str], entries: list[dict]) -> dict:
    remaining = [len(entry["imports"]) for entry in entries]
    ready = deque(i for i, count in enumerate(remaining) if not count)
    visited = 0
    while ready:
        target = ready.popleft()
        visited += 1
        for importer in entries[target]["importedBy"]:
            remaining[importer] -= 1
            if remaining[importer] == 0:
                ready.append(importer)
    if visited != len(entries):
        cyclic_names = [names[i] for i, count in enumerate(remaining) if count][:10]
        raise ValueError(f"source import graph has a cycle, involving or depending on: {cyclic_names}")
    main_id = names.index("Main") if "Main" in names else None
    reachable = set()
    stack = [] if main_id is None else [main_id]
    while stack:
        current = stack.pop()
        if current in reachable:
            continue
        reachable.add(current)
        stack.extend(edge[0] for edge in entries[current]["imports"])
    return {
        "acyclic": True,
        "topologicallyVisitedModuleCount": visited,
        "mainModuleId": main_id,
        "mainReachabilityIncludesRoot": True,
        "mainReachableModuleCount": len(reachable),
        "mainUnreachableModuleCount": len(entries) - len(reachable),
        "mainReachableInternalEdgeCount": sum(len(entries[i]["imports"]) for i in reachable),
        "mainReachableExternalEdgeCount": sum(len(entries[i]["externalImports"]) for i in reachable),
        "modulesWithoutInternalImports": sum(not entry["imports"] for entry in entries),
        "modulesWithoutAnyExplicitImports": sum(not entry["imports"] and not entry["externalImports"] for entry in entries),
        "modulesWithNoImporters": sum(not entry["importedBy"] for entry in entries),
        "maximumInternalImports": max(len(entry["imports"]) for entry in entries),
        "maximumImportedBy": max(len(entry["importedBy"]) for entry in entries),
    }


def write_json(path: Path, value) -> dict:
    data = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_bytes(data)
    temporary.replace(path)
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def build_index(source: Path, output: Path, *, expected_commit: str = SOURCE_COMMIT,
                generated_at: str = GENERATED_AT, extra_external_roots=(), progress: bool = False) -> dict:
    source = Path(source).resolve()
    output = Path(output).resolve()
    tracked, names_to_paths, object_format, tree_oid = source_inventory(source, expected_commit)
    names = sorted(names_to_paths)
    ids = {name: i for i, name in enumerate(names)}
    internal_roots = {name.split(".")[0] for name in names}
    external_roots = EXTERNAL_ROOTS | frozenset(extra_external_roots)
    entries = [{"imports": [], "externalImports": [], "importedBy": [], "lines": 0, "sha256": ""} for _ in names]
    group_modules = Counter()
    group_lines = Counter()
    external_modules = Counter()
    aggregate = hashlib.sha256()
    total_bytes = 0
    total_lines = 0
    duplicate_count = 0
    import_commands = 0
    multiline_commands = 0
    prelude_count = 0
    for i, name in enumerate(names):
        relative = names_to_paths[name]
        path = source / relative
        if path.is_symlink():
            raise ValueError(f"source symlink is not allowed: {relative}")
        raw = path.read_bytes()
        git_hash = hashlib.new(object_format)
        git_hash.update(f"blob {len(raw)}\0".encode("ascii"))
        git_hash.update(raw)
        if git_hash.hexdigest() != tracked[relative]:
            raise ValueError(f"source content differs from revision Git blob: {relative}")
        sha256 = hashlib.sha256(raw).hexdigest()
        text = raw.decode("utf-8", errors="strict")
        header = parse_header(text, relative)
        line_count = raw.count(b"\n") + int(bool(raw) and not raw.endswith(b"\n"))
        entry = entries[i]
        entry["lines"] = line_count
        entry["sha256"] = sha256
        total_bytes += len(raw)
        total_lines += line_count
        group = name.split(".")[0]
        group_modules[group] += 1
        group_lines[group] += line_count
        aggregate.update(relative.encode("utf-8") + b"\0" + sha256.encode("ascii") + b"\n")
        duplicate_count += header["duplicateImportsRemoved"]
        import_commands += header["importCommandCount"]
        multiline_commands += header["multilineImportCommandCount"]
        prelude_count += int(header["prelude"])
        for imported_name, line in header["imports"]:
            target = ids.get(imported_name)
            if target is not None:
                entry["imports"].append([target, line])
                entries[target]["importedBy"].append(i)
                continue
            namespace = imported_name.split(".")[0]
            if namespace in internal_roots:
                raise ValueError(f"{relative}:{line}: unresolved project import: {imported_name}")
            if namespace not in external_roots:
                raise ValueError(f"{relative}:{line}: unrecognized external namespace: {imported_name}")
            entry["externalImports"].append([imported_name, line])
            external_modules[imported_name] += 1
        if progress and (i + 1) % 20000 == 0:
            print(f"Verified and parsed {i + 1:,}/{len(names):,} source modules", file=sys.stderr, flush=True)
    graph = graph_statistics(names, entries)
    files = {"names.json": write_json(output / "names.json", names)}
    chunk_count = (len(names) + CHUNK_SIZE - 1) // CHUNK_SIZE
    for chunk in range(chunk_count):
        relative = f"chunks/{chunk}.json"
        files[relative] = write_json(output / relative, entries[chunk * CHUNK_SIZE:(chunk + 1) * CHUNK_SIZE])
    for path in (output / "chunks").glob("*.json"):
        if path.stem.isdecimal() and int(path.stem) >= chunk_count:
            path.unlink()
    manifest = {
        "schema": "lean-module-index-v1",
        "sourceCommit": expected_commit,
        "sourceRepository": SOURCE_REPOSITORY,
        "sourceDirectory": "src",
        "moduleCount": len(names),
        "internalEdgeCount": sum(len(entry["imports"]) for entry in entries),
        "externalEdgeCount": sum(len(entry["externalImports"]) for entry in entries),
        "totalLines": total_lines,
        "totalSourceBytes": total_bytes,
        "chunkSize": CHUNK_SIZE,
        "chunkCount": chunk_count,
        "namesFile": "names.json",
        "chunkPattern": "chunks/{chunk}.json",
        "generatedAt": generated_at,
        "sourceTreeGitOid": tree_oid,
        "sourceFilesSha256": aggregate.hexdigest(),
        "extraction": {
            "scope": "Every committed src/**/*.lean file; explicit header imports only",
            "edgeDirection": "importing module to imported module",
            "sourceLineMeaning": "1-based line containing the imported module name",
            "moduleIdMeaning": "Index in the lexicographically sorted names.json array",
            "sourcePathRule": "src/ + module name with dots replaced by slashes + .lean",
            "sourceRevisionVerified": True,
            "gitObjectFormat": object_format,
            "gitBlobHashesVerified": len(names),
            "trackedLeanFileCount": len(tracked),
            "discoveredLeanFileCount": len(names),
            "parsedLeanFileCount": len(names),
            "coverageFraction": 1,
            "unresolvedProjectImportCount": 0,
            "unrecognizedExternalNamespaceCount": 0,
            "importCommandCount": import_commands,
            "multilineImportCommandCount": multiline_commands,
            "duplicateImportsRemoved": duplicate_count,
            "preludeModuleCount": prelude_count,
            "comments": "Line comments and arbitrarily nested block comments are ignored",
            "externalImports": "Recognized namespace, not expanded or compiled in this index",
            "recognizedExternalNamespaces": sorted(external_roots),
            "implicitImportsIncluded": False,
            "declarationDependenciesExtracted": False,
            "leanExecuted": False,
            "aggregateHashRule": "SHA-256 over (source relative path + NUL + file SHA-256 hex + LF), in module ID order",
            "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
        "groups": [{"name": name, "modules": group_modules[name], "lines": group_lines[name]} for name in sorted(group_modules)],
        "externalModules": [{"name": name, "importCount": external_modules[name]} for name in sorted(external_modules)],
        "graph": graph,
        "files": files,
        "dataFileBytes": sum(item["bytes"] for item in files.values()),
    }
    write_json(output / "manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True, help="Read-only upstream Git checkout")
    parser.add_argument("--output-dir", type=Path, default=Path("public/riemann-modules"))
    parser.add_argument("--source-commit", default=SOURCE_COMMIT)
    parser.add_argument("--generated-at", default=GENERATED_AT, help="Fixed value keeps output reproducible")
    parser.add_argument("--external-root", action="append", default=[], help="Additional explicitly recognized external namespace")
    args = parser.parse_args()
    try:
        manifest = build_index(args.source_dir, args.output_dir, expected_commit=args.source_commit,
                               generated_at=args.generated_at, extra_external_roots=args.external_root, progress=True)
    except (ValueError, UnicodeError, OSError) as exc:
        print(f"Extraction failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({key: manifest[key] for key in ("sourceCommit", "moduleCount", "internalEdgeCount", "externalEdgeCount", "totalLines", "totalSourceBytes", "dataFileBytes", "sourceFilesSha256", "graph")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
