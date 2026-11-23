#!/usr/bin/env python3
"""Extract two conservative rounds of explicit Lean declaration references.

This is a static source index, not a Lean parser, elaborator, or kernel closure.
Only named, line-start declarations are candidates. A reference must resolve in
the current/parent/root namespace or an explicit open namespace, be visible in
the source module's import closure, and have its committed source bytes checked.
Private names, ambiguous names, inferred field notation, and generated names are
not guessed. No mathematical statements or proof steps are synthesized.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict, OrderedDict
from dataclasses import dataclass, field
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time


SOURCE_COMMIT = "7cbf7a0c32fca1badf05931879a37c3f8a2b03b4"
SOURCE_REPOSITORY = "CocoSgt/riemann-hypothesis-lean"
ROOT = Path(__file__).resolve().parent.parent
SEMANTICS = "explicit resolved source reference, not elaborated proof-term dependency"
DECL_KINDS = frozenset("theorem lemma def abbrev axiom opaque constant structure class inductive instance".split())
MODIFIERS = "private|protected|noncomputable|unsafe|partial|local|scoped|public"
COMMANDS = "|".join(sorted(DECL_KINDS | set("namespace section end open variable variables universe universes include omit attribute export set_option syntax macro macro_rules elab elab_rules example import initialize builtin_initialize mutual deriving notation infix infixl infixr prefix postfix declare_syntax_cat".split()), key=len, reverse=True))
COMMAND_RE = re.compile(r"^(?P<indent>[ \t]*)(?:@\[[^\]\n]*\][ \t]*)*(?P<mods>(?:(?:" + MODIFIERS + r")[ \t]+)*)(?P<command>" + COMMANDS + r")\b|^(?P<attribute>[ \t]*@\[)", re.MULTILINE)
PART = r"(?:«[^»\n]+»|[^\W\d][\w'!?]*)"
NAME_RE = re.compile(PART + r"(?:\." + PART + r")*")
RG_PATTERN = r"^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:" + MODIFIERS + r")[ \t]+)*(?:" + "|".join(sorted(DECL_KINDS)) + r")[ \t]+"
DECL_LINE_RE = re.compile(RG_PATTERN + r"(?P<name>" + PART + r"(?:\." + PART + r")*)")
IGNORED = frozenset("""
theorem lemma def abbrev axiom opaque constant structure class inductive instance
private protected noncomputable unsafe partial local scoped public namespace section end
open variable variables universe universes include omit attribute export set_option
Type Prop Sort Nat Int Bool True False true false sorry admit by fun forall match with
let letI letI' letI' have haveI haveI' suffices show from in if then else do return
where deriving extends at only all_goals any_goals first next case induction cases
intro intros revert obtain rcases rintro rfl exact refine apply constructor assumption
simpa simp simp_all dsimp rw rfl erfl erw nth_rw change convert conv unfold fold
classical infer_instance inferInstance inferInstanceAs decide native_decide aesop
omega linarith nlinarith norm_num norm_cast exact_mod_cast positivity ring ring_nf
ext funext congr congrm congrArg congrFun specialize replace clear rename_i subst
by_cases by_contra contradiction exfalso false_or_by_contra push_neg contrapose
filter_upwards choose choose! using calc termination_by decreasing_by induction'
cases' repeat try done skip trivial tauto solve all_goals focus fail_if_success
haveI letI run_tac run_elab set_option maxRecDepth maxHeartbeats pp maxRecDepth
""".split())


def load_module_tools():
    spec = importlib.util.spec_from_file_location("riemann_module_extractor", Path(__file__).with_name("extract-riemann-modules.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def mask_noncode(text: str) -> str:
    """Replace nested comments and strings with spaces, preserving all offsets."""
    chars = list(text)
    i, n = 0, len(text)
    while i < n:
        begin = i
        if text.startswith("--", i):
            end = text.find("\n", i)
            i = n if end == -1 else end
        elif text.startswith("/-", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if text.startswith("/-", i):
                    depth, i = depth + 1, i + 2
                elif text.startswith("-/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            if depth:
                raise ValueError("unterminated Lean block comment")
        elif text[i] == '"':
            # Raw string delimiters r#"..."# are handled at their opening quote.
            raw = re.search(r"(?<![\w'])r(#+)$", text[max(0, i - 64):i])
            delimiter = '"' + raw[1] if raw else '"'
            i += 1
            while i < n:
                if not raw and text[i] == "\\":
                    i += 2
                elif text.startswith(delimiter, i):
                    i += len(delimiter)
                    break
                else:
                    i += 1
            else:
                raise ValueError("unterminated Lean string")
        elif text[i] == "«":
            end = text.find("»", i + 1)
            if end < 0:
                raise ValueError("unterminated escaped Lean identifier")
            i = end + 1
            continue
        else:
            i += 1
            continue
        for pos in range(begin, min(i, n)):
            if chars[pos] != "\n":
                chars[pos] = " "
    return "".join(chars)


def name_parts(name):
    return re.findall(PART, name)


def qualify(namespace, name):
    if name.startswith("_root_."):
        return name[7:]
    return namespace + "." + name if namespace else name


def namespace_prefixes(namespace):
    parts = name_parts(namespace)
    return [".".join(parts[:i]) for i in range(len(parts), -1, -1)]


def local_names(text):
    """Conservative shadow set: collect binders across the whole declaration.

    Over-approximating lexical scope can omit a reference; it cannot manufacture
    one. This intentionally does not try to infer a local variable's type.
    """
    result = set()
    simple = re.compile(r"(?:" + PART + r"\s*)+\Z")
    for pattern in [r"[({\[]\s*([^:(){}\[\]\n]+)\s*:(?!=)",
                    r"(?:∀|∃|\bfun)\s+([^\n:,=(){}\[\]]+)(?=\s*(?::|,|=>))"]:
        for match in re.finditer(pattern, text):
            if simple.fullmatch(match[1].strip()):
                result.update(NAME_RE.findall(match[1]))
    for match in re.finditer(r"\b(?:let|letI|have|haveI|suffices)\s+(?:rec\s+)?(" + PART + r")", text):
        result.add(match[1])
    for match in re.finditer(r"\b(?:intro|intros|funext|rename_i)\s+([^\n;]+)", text):
        # A combinator or assignment ends the introduction list.
        before = re.split(r"(?:\s<;>|:=|=>)", match[1])[0]
        result.update(NAME_RE.findall(before))
    for match in re.finditer(r"(?:\bobtain\s+|\brintro\s+|\bwith\s+)⟨([^:=\n]+)⟩", text):
        result.update(NAME_RE.findall(match[1]))
    for match in re.finditer(r"\bchoose!?\s+([^\n]+?)\s+using\b", text):
        result.update(NAME_RE.findall(match[1]))
    for match in re.finditer(r"^\s*(?:\||case\s+)([^=\n]+)=>", text, re.MULTILINE):
        result.update(NAME_RE.findall(match[1]))
    result.discard("_")
    return result


@dataclass
class Declaration:
    name: str
    short: str
    kind: str
    module: str
    path: str
    start: int
    body_start: int
    end: int
    start_line: int
    end_line: int
    namespace: str
    opens: tuple
    variables: frozenset
    indent: int = 0
    private: bool = False
    protected: bool = False


@dataclass
class SourceModule:
    name: str
    path: str
    text: str
    clean: str
    sha256: str
    imports: list
    declarations: list = field(default_factory=list)
    unsupported: list = field(default_factory=list)


def parse_source(name, path, text, imports):
    clean = mask_noncode(text)
    module = SourceModule(name, path, text, clean, hashlib.sha256(text.encode()).hexdigest(), imports)
    namespace, opens, variables = "", [], set()
    stack, pending_open = [], []
    active = None
    commands = list(COMMAND_RE.finditer(clean))

    def finish(end):
        nonlocal active
        if active is not None:
            clipped = clean[active.start:end].rstrip()
            active.end = active.start + len(clipped)
            active.end_line = clean.count("\n", 0, active.end) + 1
            module.declarations.append(active)
            active = None

    for index, command in enumerate(commands):
        indent = len((command["indent"] or command["attribute"] or "").expandtabs())
        if active is not None:
            if indent > active.indent:
                continue
            finish(command.start())
        if command["attribute"]:
            continue
        kind = command["command"]
        line_end = clean.find("\n", command.end())
        line_end = len(clean) if line_end < 0 else line_end
        rest = clean[command.end():line_end].strip()
        if kind in DECL_KINDS:
            match = NAME_RE.match(clean, command.end() + len(clean[command.end():]) - len(clean[command.end():].lstrip()))
            if match is None or match.start() > line_end or match[0] in {"where", "extends"}:
                module.unsupported.append({"line": clean.count("\n", 0, command.start()) + 1,
                                           "reason": "anonymous-or-multiline-declaration-name"})
                pending_open = []
                continue
            raw_name = match[0]
            mods = command["mods"].split()
            start = command.start("command")
            active = Declaration(qualify(namespace, raw_name), name_parts(raw_name)[-1], kind, name, path,
                                 start, match.end(), 0, clean.count("\n", 0, start) + 1, 0,
                                 namespace, tuple(opens + pending_open), frozenset(variables),
                                 len(command["indent"].expandtabs()),
                                 "private" in mods, "protected" in mods)
            pending_open = []
        elif kind in {"namespace", "section", "mutual"}:
            stack.append((namespace, list(opens), set(variables)))
            if kind == "namespace":
                match = NAME_RE.match(rest)
                if match is None:
                    raise ValueError(f"{path}: unsupported namespace command")
                namespace = qualify(namespace, match[0])
        elif kind == "end":
            if not stack:
                module.unsupported.append({"line": clean.count("\n", 0, command.start()) + 1,
                                           "reason": "unmatched-end-command"})
            else:
                namespace, opens, variables = stack.pop()
            pending_open = []
        elif kind == "open":
            if rest.startswith("scoped "):
                continue
            command_local = bool(re.search(r"\bin\s*$", rest))
            content = re.sub(r"\bin\s*$", "", rest).strip()
            if any(mark in content for mark in ("(", "hiding", "renaming")):
                module.unsupported.append({"line": clean.count("\n", 0, command.start()) + 1,
                                           "reason": "selective-or-renamed-open"})
                continue
            new_opens = [(token, namespace) for token in NAME_RE.findall(content)]
            if command_local:
                pending_open.extend(new_opens)
            else:
                opens.extend(new_opens)
        elif kind in {"variable", "variables"}:
            stop = commands[index + 1].start() if index + 1 < len(commands) else len(clean)
            variables.update(local_names(clean[command.end():stop]))
        elif kind == "export":
            module.unsupported.append({"line": clean.count("\n", 0, command.start()) + 1,
                                       "reason": "export-alias-not-expanded"})
    finish(len(clean))
    return module


class SourceIndex:
    def __init__(self, source, expected_commit, module_index=None, progress=False):
        self.source = source.resolve()
        self.tools = load_module_tools()
        self.tracked, self.paths, self.object_format, self.tree_oid = self.tools.source_inventory(self.source, expected_commit)
        self.modules, self.by_leaf = {}, defaultdict(set)
        self.imports, self.index_hashes = {}, {}
        self.closures = OrderedDict()
        self.candidate_count = 0
        self.progress = progress
        self.expected_commit = expected_commit
        if module_index is not None:
            self.read_import_index(module_index)
        self.scan_candidates()

    def log(self, message):
        if self.progress:
            print(message, file=sys.stderr, flush=True)

    def read_import_index(self, folder):
        manifest = json.loads((folder / "manifest.json").read_text())
        if manifest["sourceCommit"] != self.expected_commit or manifest["sourceTreeGitOid"] != self.tree_oid:
            raise ValueError("module index does not match the pinned source revision/tree")

        def read(relative):
            raw = (folder / relative).read_bytes()
            expected = manifest["files"][relative]
            if len(raw) != expected["bytes"] or hashlib.sha256(raw).hexdigest() != expected["sha256"]:
                raise ValueError(f"module index checksum mismatch: {relative}")
            return json.loads(gzip.decompress(raw) if relative.endswith(".gz") else raw)

        names = read(manifest["namesFile"])
        if names != sorted(self.paths):
            raise ValueError("module index coverage does not match source inventory")
        entries = []
        for chunk in range(manifest["chunkCount"]):
            entries.extend(read(manifest["chunkPattern"].replace("{chunk}", str(chunk))))
        if len(entries) != len(names):
            raise ValueError("module index entry count mismatch")
        for name, entry in zip(names, entries):
            self.imports[name] = [names[edge[0]] for edge in entry["imports"]]
            self.index_hashes[name] = entry["sha256"]
        self.log(f"Loaded verified import index: {len(names):,} source modules")

    def scan_candidates(self):
        # The fast scan is a candidate locator only. Every candidate is later
        # parsed after comments/strings are masked and its Git blob is verified.
        process = subprocess.Popen(["rg", "--no-heading", "--line-number", "--color", "never",
                                    "--glob", "*.lean", RG_PATTERN, "src"], cwd=self.source,
                                   text=True, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for line in process.stdout:
            path, _, content = line.rstrip("\n").split(":", 2)
            match = DECL_LINE_RE.match(content)
            if match and path in self.tracked:
                leaf = name_parts(match["name"])[-1]
                self.by_leaf[leaf].add(path[4:-5].replace("/", "."))
                self.candidate_count += 1
        stderr = process.stderr.read()
        if process.wait() not in (0, 1):
            raise ValueError(f"declaration candidate scan failed: {stderr}")
        self.log(f"Located {self.candidate_count:,} declaration candidates (not a completeness claim)")

    def load(self, name):
        if name in self.modules:
            return self.modules[name]
        relative = self.paths[name]
        path = self.source / relative
        if path.is_symlink():
            raise ValueError(f"source symlink is not allowed: {relative}")
        raw = path.read_bytes()
        digest = hashlib.new(self.object_format, f"blob {len(raw)}\0".encode() + raw).hexdigest()
        if digest != self.tracked[relative]:
            raise ValueError(f"source Git blob mismatch: {relative}")
        text = raw.decode("utf-8")
        imported = [module for module, _ in self.tools.parse_imports(text, relative)]
        internal = [module for module in imported if module in self.paths]
        if name in self.imports and set(internal) != set(self.imports[name]):
            raise ValueError(f"module index import mismatch: {relative}")
        self.imports[name] = internal
        module = parse_source(name, relative, text, imported)
        if name in self.index_hashes and module.sha256 != self.index_hashes[name]:
            raise ValueError(f"module index source checksum mismatch: {relative}")
        self.modules[name] = module
        return module

    def closure(self, module):
        if module in self.closures:
            self.closures.move_to_end(module)
            return self.closures[module]
        seen, todo = set(), [module]
        while todo:
            current = todo.pop()
            if current in seen:
                continue
            seen.add(current)
            if current not in self.imports:
                self.load(current)
            todo.extend(self.imports[current])
        self.closures[module] = seen
        if len(self.closures) > 24:
            self.closures.popitem(last=False)
        return seen

    def candidates(self, name, consumer):
        leaf = name_parts(name)[-1]
        visible = self.closure(consumer.module)
        result = []
        for module_name in sorted(self.by_leaf.get(leaf, set()) & visible):
            for declaration in self.load(module_name).declarations:
                if declaration.name != name:
                    continue
                if module_name == consumer.module and declaration.start >= consumer.start:
                    continue
                if declaration.private and module_name != consumer.module:
                    continue
                result.append(declaration)
        return result

    def resolve(self, token, consumer):
        if token.startswith("_root_."):
            searches = [(token[7:], "root-qualified")]
        else:
            searches = [(qualify(prefix, token), "current-or-parent-namespace" if prefix else "root-name")
                        for prefix in namespace_prefixes(consumer.namespace)]
        for name, method in searches:
            matches = self.candidates(name, consumer)
            private = [d for d in matches if d.private]
            if private:
                return None, "private", []
            if len(matches) == 1:
                return matches[0], method, []
            if len(matches) > 1:
                return None, "ambiguous", [f"{d.name}@{d.module}" for d in matches]
        if token.startswith("_root_."):
            return None, "unresolved", []
        matches = {}
        for opened, at_namespace in consumer.opens:
            for prefix in namespace_prefixes(at_namespace):
                opened_name = qualify(prefix, opened)
                for declaration in self.candidates(qualify(opened_name, token), consumer):
                    if declaration.private or declaration.protected:
                        continue
                    matches[(declaration.module, declaration.start)] = declaration
        if len(matches) == 1:
            return next(iter(matches.values())), "explicit-open-namespace", []
        return None, "ambiguous" if matches else "unresolved", [d.name for d in matches.values()]

    def references(self, declaration):
        module = self.load(declaration.module)
        body = module.clean[declaration.body_start:declaration.end]
        shadows = set(declaration.variables) | local_names(body)
        field_binders = set()
        if declaration.kind in {"structure", "class"}:
            # A field name is a binder, including fields with explicit arguments.
            # Its type still contains genuine references and remains tokenized.
            pattern = r"^[ \t]+(" + PART + r")(?:(?:[ \t]*)[({\[][^\n]*?[\])}])*[ \t]*:(?!=)"
            field_binders.update(match[1] for match in re.finditer(pattern, body, re.MULTILINE))
        outcomes, unresolved, references = Counter(), [], defaultdict(list)
        seen = set()
        for match in NAME_RE.finditer(body):
            token = match[0]
            if token in IGNORED or token == "_":
                continue
            line = module.clean.count("\n", 0, declaration.body_start + match.start()) + 1
            if (token, line) in seen:
                continue
            seen.add((token, line))
            parts = name_parts(token)
            if parts[0] in field_binders:
                outcomes["field-binder"] += 1
                continue
            if parts[0] in shadows or (match.start() and body[match.start() - 1] in ".'?"):
                outcomes["local-or-projection"] += 1
                continue
            before = body[:match.start()].rstrip()
            line_prefix = body[body.rfind("\n", 0, match.start()) + 1:match.start()].strip()
            if re.match(r"\s*:=", body[match.end():]) and (not line_prefix or (before and before[-1] in "({,")):
                outcomes["binding-or-field-label"] += 1
                continue
            if token == declaration.name or token == declaration.short:
                outcomes["self-name"] += 1
                continue
            target, method, candidates = self.resolve(token, declaration)
            if target is None:
                outcomes[method] += 1
                unresolved.append({"token": token, "line": line, "reason": method,
                                   **({"candidates": sorted(candidates)} if candidates else {})})
            else:
                outcomes["resolved"] += 1
                references[(target.module, target.start)].append((target, token, line, method))
        return references, outcomes, unresolved


def build_expansion(source, overview, expected_commit=SOURCE_COMMIT, module_index=None, progress=False):
    if overview["sourceCommit"] != expected_commit:
        raise ValueError("overview source revision mismatch")
    repository = overview.get("sourceRepository", SOURCE_REPOSITORY)
    index = SourceIndex(source, expected_commit, module_index, progress)
    seeds, original_ids = {}, {}
    for node in overview["nodes"]:
        module = index.load(node["module"])
        matches = [declaration for declaration in module.declarations
                   if declaration.name == node["declarationName"] and not declaration.private]
        if len(matches) != 1:
            raise ValueError(f"overview declaration could not be uniquely located: {node['declarationName']}")
        declaration = matches[0]
        if declaration.start_line != node["evidence"][0]["startLine"]:
            raise ValueError(f"overview declaration location mismatch: {node['declarationName']}")
        seeds[node["id"]] = declaration
        original_ids[declaration.name] = node["id"]
    order = {node["id"]: i for i, node in enumerate(overview["nodes"])}
    original_pairs = {(edge["from"], edge["to"]) for edge in overview["edges"]}
    new, edges = {}, {}
    outcomes, consumer_reports = Counter(), []
    duplicate_pairs = set()

    def evidence(declaration, start_line=None, end_line=None, **extra):
        start_line = start_line or declaration.start_line
        end_line = end_line or declaration.end_line
        fragment = f"#L{start_line}" + (f"-L{end_line}" if end_line != start_line else "")
        return {"path": declaration.path, "startLine": start_line, "endLine": end_line,
                "url": f"https://github.com/{repository}/blob/{expected_commit}/{declaration.path}{fragment}",
                "label": declaration.name if not extra else f"{declaration.name} 的显式源码引用",
                "sha256": index.load(declaration.module).sha256, **extra}

    def expand(consumer_id, declaration, tier, owners):
        refs, counts, unresolved = index.references(declaration)
        outcomes.update(counts)
        consumer_reports.append({"id": consumer_id, "declarationName": declaration.name,
                                 "path": declaration.path, "expandedAtTier": tier,
                                 "resolvedDeclarationCount": len(refs), "referenceOutcomes": dict(sorted(counts.items())),
                                 "unexpandedReferences": unresolved})
        for items in refs.values():
            dependency = items[0][0]
            dependency_id = original_ids.get(dependency.name, "decl:" + dependency.name)
            if dependency_id == consumer_id:
                continue
            if dependency.name not in original_ids:
                entry = new.setdefault(dependency_id, {"declaration": dependency, "tier": tier, "owners": set()})
                if entry["declaration"].module != dependency.module:
                    raise ValueError(f"ambiguous expansion declaration identity: {dependency.name}")
                entry["tier"] = min(entry["tier"], tier)
                entry["owners"].update(owners)
            pair = (dependency_id, consumer_id)
            if pair in original_pairs:
                duplicate_pairs.add(pair)
                continue
            record = edges.setdefault(pair, {"from": dependency_id, "to": consumer_id, "kind": "source-reference",
                                            "revealTier": tier, "reason": "消费方声明的源码显式引用该声明；仅表示静态解析到的源码名称引用。",
                                            "evidence": [], "dependencySemantics": SEMANTICS})
            record["revealTier"] = min(record["revealTier"], tier)
            existing = {(item["startLine"], item["token"]) for item in record["evidence"]}
            for _, token, line, method in items:
                if (line, token) not in existing:
                    record["evidence"].append(evidence(declaration, line, line, token=token,
                                                         resolvedDeclaration=dependency.name, resolution=method))
                    existing.add((line, token))
        return counts

    for node_id, declaration in seeds.items():
        expand(node_id, declaration, 1, {node_id})
    tier_one = sorted(new)
    index.log(f"Round 1: {len(tier_one):,} new declarations, {len(edges):,} new source-reference edges")
    for number, node_id in enumerate(tier_one, 1):
        entry = new[node_id]
        entry["outcomes"] = expand(node_id, entry["declaration"], 2, set(entry["owners"]))
        if number % 50 == 0:
            index.log(f"Round 2: inspected {number}/{len(tier_one)} declarations; {len(new):,} new nodes so far")
    # Propagate origins for references among first-tier nodes as a finite set
    # union, so shared declarations retain all original overview contexts.
    changed = True
    while changed:
        changed = False
        for edge in edges.values():
            if edge["from"] in new and edge["to"] in new:
                target, consumer = new[edge["from"]], new[edge["to"]]
                before = len(target["owners"])
                target["owners"].update(consumer["owners"])
                changed = changed or len(target["owners"]) != before
    nodes = []
    for node_id, entry in new.items():
        declaration = entry["declaration"]
        owners = sorted(entry["owners"], key=order.__getitem__)
        counts = entry.get("outcomes", Counter())
        unexpanded_count = sum(counts.get(reason, 0) for reason in ("unresolved", "ambiguous", "private"))
        boundary = entry["tier"] == 2 or not counts.get("resolved") or unexpanded_count > 0
        nodes.append({"id": node_id, "declarationName": declaration.name, "module": declaration.module,
                      "label": declaration.short, "description": f"固定源码中的 {declaration.kind} 声明；由概览节点的显式源码引用展开。这里记录声明位置与名称引用，不推断完整数学命题。",
                      "status": "source", "revealTier": entry["tier"], "ownerId": owners[0],
                      "overviewIds": owners, "kind": declaration.kind, "evidence": [evidence(declaration)],
                      "boundary": {"isBoundary": boundary, "reason": "depth-limit" if entry["tier"] == 2 else "static-resolution-limit" if boundary else "expanded-one-round",
                                   "label": "本轮展开边界；不是数学公理" if boundary else "已展开一轮显式源码引用；仍有静态解析边界",
                                   "mathematicalAxiom": False, "referencesExpanded": entry["tier"] == 1,
                                   "unexpandedReferenceCount": unexpanded_count},
                      "sourceAudit": "declaration and explicit source-reference tokens verified against pinned Git blobs; Lean not executed",
                      "verification": "源码位置与引用字符已核对；不是 Lean 内核证明依赖闭包。"})
    nodes.sort(key=lambda node: (node["revealTier"], order[node["ownerId"]], node["declarationName"]))
    edge_list = sorted(edges.values(), key=lambda edge: (edge["revealTier"], edge["to"], edge["from"]))
    for edge in edge_list:
        edge["evidence"].sort(key=lambda item: (item["startLine"], item["token"]))
    coverage = {
        "mode": "two-round-explicit-source-reference-expansion", "maximumReferenceDepth": 2,
        "overviewNodeCount": len(seeds), "overviewEdgeCount": len(overview["edges"]),
        "tier1NewNodeCount": sum(node["revealTier"] == 1 for node in nodes),
        "tier2NewNodeCount": sum(node["revealTier"] == 2 for node in nodes),
        "newNodeCount": len(nodes), "newEdgeCount": len(edge_list),
        "overviewReferenceEdgesReused": len(duplicate_pairs),
        "sourceRevisionVerified": True, "sourceTreeGitOid": index.tree_oid,
        "sourceModuleInventoryCount": len(index.paths), "candidateDeclarationLineCount": index.candidate_count,
        "parsedSourceModuleCount": len(index.modules), "verifiedGitBlobCount": len(index.modules),
        "parsedNamedDeclarationCount": sum(len(module.declarations) for module in index.modules.values()),
        "expandedDeclarationCount": len(consumer_reports), "referenceOutcomes": dict(sorted(outcomes.items())),
        "consumers": consumer_reports,
        "unsupportedSourceCommands": [{"path": module.path, **item} for module in sorted(index.modules.values(), key=lambda mod: mod.path) for item in module.unsupported],
        "edgeDirection": "referenced declaration -> source declaration containing the explicit reference",
        "nodeIdentity": "decl: + source-qualified public declaration name; original overview IDs are reused",
        "resolution": "current/parent/root namespace, then unique explicitly opened namespace, within transitive project imports; same-module references must precede their consumer",
        "localBinders": "conservative whole-declaration shadow set; may omit references outside a binder's lexical scope",
        "privateDeclarationsIncluded": False, "externalLibraryDeclarationsIncluded": False,
        "leanExecuted": False, "completeKernelClosure": False,
        "boundaryLabel": "本轮展开边界；不是数学公理，也不是完整内核依赖闭包。",
        "limitations": ["仅识别行首具名声明；不导出完整项目声明索引。", "不推断隐式参数、类型类实例、宏展开、字段点记法或编译后的证明项依赖。",
                        "私有声明、自动生成声明、选择性 open 与 export 别名不展开；未解析名称逐个记录。",
                        "Mathlib 等外部库声明不在本项目源码范围内；静态解析的唯一性限于可见项目声明。",
                        "第二轮新增节点停止继续展开；叶节点代表本轮提取边界。"],
        "extractorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    return {"schema": "riemann-source-expansion-v1", "sourceCommit": expected_commit,
            "sourceRepository": repository, "nodes": nodes, "edges": edge_list, "coverage": coverage}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--overview", type=Path, default=ROOT / "public/riemann-graph.json")
    parser.add_argument("--output", type=Path, default=ROOT / "public/riemann-expansion.json")
    parser.add_argument("--expected-commit", default=SOURCE_COMMIT)
    parser.add_argument("--module-index", type=Path, default=ROOT / "public/riemann-modules")
    parser.add_argument("--no-module-index", action="store_true")
    parser.add_argument("--progress", action="store_true")
    args = parser.parse_args()
    started = time.monotonic()
    try:
        data = build_expansion(args.source, json.loads(args.overview.read_text()), args.expected_commit,
                               None if args.no_module_index else args.module_index, args.progress)
        raw = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".json.tmp")
        temporary.write_bytes(raw)
        temporary.replace(args.output)
        print(json.dumps({"newNodes": len(data["nodes"]), "newEdges": len(data["edges"]),
                          "tier1NewNodes": data["coverage"]["tier1NewNodeCount"],
                          "tier2NewNodes": data["coverage"]["tier2NewNodeCount"],
                          "seconds": round(time.monotonic() - started, 3), "bytes": len(raw),
                          "sha256": hashlib.sha256(raw).hexdigest()}, ensure_ascii=False))
    except (ValueError, OSError, KeyError, AssertionError) as error:
        print(f"Extraction failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
