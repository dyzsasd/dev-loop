#!/usr/bin/env python3
"""Fail closed on source-file injection and unsafe npm lockfile changes.

This checker intentionally uses only the Python standard library and Git. CI runs
it before Node is configured or npm is invoked, so an injected lifecycle script
cannot execute before the repository is inspected.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_SUFFIXES = {
    ".bash",
    ".cjs",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".mts",
    ".py",
    ".sh",
    ".ts",
    ".tsx",
    ".zsh",
}
SKIP_DIRECTORIES = {".git", ".mypy_cache", ".pytest_cache", ".venv", "__pycache__", "node_modules"}
MAX_HORIZONTAL_WHITESPACE = 127
MAX_PHYSICAL_LINE = 1_000

# Keep signatures split so this scanner and its tests do not contain the IOCs
# they are responsible for detecting.
EXACT_IOCS = (
    ("campaign-marker", b"5-3-" + b"339-du"),
    ("npm-persistence-marker", b"C260" + b"521A"),
    ("npm-persistence-marker", b"RS260" + b"605"),
    ("obfuscator-marker", b"_$" + b"_2fdd"),
    ("encoded-loader-marker", b"dmFyIF8kXzJmZGQ9" + b"KGZ1bmN0aW9u"),
    ("loader-global", b"global." + b"i="),
)
INJECTED_REQUIRE_SHIM = (
    b"import { createRequire } from "
    + b"'module';\n"
    + b"const require = "
    + b"createRequire(import.meta.url);\n"
)
EVAL_RE = re.compile(rb"\beval\s*\(")
DECODE_RE = re.compile(rb"\batob\s*\(|\bBuffer\s*\.\s*from\s*\([^\n]{0,256}\bbase64\b", re.IGNORECASE)
FUNCTION_CONSTRUCTOR_RE = re.compile(
    rb"\b(?:new\s+)?Function\s*\(|\bFunction\s*\.\s*constructor\b|\[['\"]constructor['\"]\]"
)
HORIZONTAL_PADDING_RE = re.compile(rb"[ \t]{128,}(?=\S)")
RELEASE_SCRIPT_EXACT = {
    "typecheck": "tsc -p tsconfig.check.json",
    "build": (
        "rm -rf dist .claude-plugin skills references hooks config && "
        "tsc -p tsconfig.build.json && chmod +x dist/cli.js dist/server.js && "
        "cp -R ../.claude-plugin ../skills ../references ../hooks ../config ./"
    ),
}
TEST_SEGMENT_RE = re.compile(
    r"(?:DEVLOOP_CHANNEL_DRYRUN=1 DEVLOOP_CHANNEL_TOKEN=xoxb-DRYRUNSECRET "
    r"DEVLOOP_MIRROR_DRYRUN=1 )?node (test/[a-z0-9-]+\.ts)\Z"
)
IMPLICIT_RELEASE_HOOKS = {
    "prebuild",
    "postbuild",
    "pretest",
    "posttest",
    "pretypecheck",
    "posttypecheck",
}


@dataclass(frozen=True)
class Finding:
    path: str
    rule: str
    offset: int
    line: int
    column: int
    detail: str

    def render(self) -> str:
        return f"{self.path}:{self.line}:{self.column}: {self.rule}: {self.detail}"


class ScanError(RuntimeError):
    """The scanner could not establish a trustworthy result."""


def _location(data: bytes, offset: int) -> tuple[int, int]:
    line = data.count(b"\n", 0, offset) + 1
    previous_newline = data.rfind(b"\n", 0, offset)
    column = offset + 1 if previous_newline < 0 else offset - previous_newline
    return line, column


def _finding(path: str, data: bytes, rule: str, offset: int, detail: str) -> Finding:
    line, column = _location(data, offset)
    return Finding(path, rule, offset, line, column, detail)


def _is_executable_source(path: PurePosixPath, data: bytes) -> bool:
    if path.suffix.lower() in SOURCE_SUFFIXES:
        return True
    first_line = data.split(b"\n", 1)[0]
    return first_line.startswith(b"#!") and any(runtime in first_line for runtime in (b"node", b"python", b"sh"))


def _scan_lockfile(path: str, data: bytes, *, source_path: str | None = None) -> list[Finding]:
    lockfile_path = PurePosixPath(path if source_path is None else source_path)
    if lockfile_path.name not in {"package-lock.json", "npm-shrinkwrap.json"}:
        return []
    try:
        document = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return [_finding(path, data, "invalid-lockfile", 0, str(exc))]

    packages = document.get("packages")
    if not isinstance(packages, dict):
        return [_finding(path, data, "invalid-lockfile", 0, "missing packages object")]

    findings: list[Finding] = []
    for package_path, metadata in packages.items():
        if not isinstance(metadata, dict):
            findings.append(_finding(path, data, "invalid-lockfile", 0, f"{package_path!r} metadata is not an object"))
            continue
        if package_path and metadata.get("hasInstallScript") is True:
            findings.append(
                _finding(path, data, "dependency-install-script", 0, f"{package_path} declares an install lifecycle script")
            )
        resolved = metadata.get("resolved")
        if isinstance(resolved, str):
            if not resolved.startswith("https://registry.npmjs.org/"):
                findings.append(_finding(path, data, "non-registry-dependency", 0, f"{package_path}: {resolved}"))
            if not metadata.get("integrity"):
                findings.append(_finding(path, data, "missing-package-integrity", 0, package_path or "<root>"))
    return findings


def _scan_release_manifest(
    path: str,
    data: bytes,
    *,
    source_path: str | None = None,
    expected_test_paths: frozenset[str] | None = None,
) -> list[Finding]:
    manifest_path = PurePosixPath(path if source_path is None else source_path)
    if manifest_path != PurePosixPath("hub/package.json") or expected_test_paths is None:
        return []
    try:
        document = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return [_finding(path, data, "invalid-package-manifest", 0, str(exc))]

    scripts = document.get("scripts")
    if not isinstance(scripts, dict):
        return [_finding(path, data, "unsafe-package-script", 0, "missing scripts object")]

    findings: list[Finding] = []
    for script_name, expected in RELEASE_SCRIPT_EXACT.items():
        if scripts.get(script_name) != expected:
            findings.append(
                _finding(path, data, "unsafe-package-script", 0, f"{script_name!r} is not the audited command")
            )
    present_hooks = sorted(IMPLICIT_RELEASE_HOOKS.intersection(scripts))
    if present_hooks:
        findings.append(
            _finding(path, data, "unsafe-package-script", 0, f"implicit release hooks present: {', '.join(present_hooks)}")
        )

    test_script = scripts.get("test")
    test_paths: list[str] = []
    if isinstance(test_script, str):
        for segment in test_script.split(" && "):
            match = TEST_SEGMENT_RE.fullmatch(segment)
            if match is None:
                findings.append(
                    _finding(path, data, "unsafe-package-script", 0, f"unaudited test command segment: {segment!r}")
                )
                break
            test_paths.append(match.group(1))
    else:
        findings.append(_finding(path, data, "unsafe-package-script", 0, "missing string-valued test script"))

    if len(test_paths) != len(set(test_paths)) or frozenset(test_paths) != expected_test_paths:
        findings.append(
            _finding(path, data, "unsafe-package-script", 0, "test script must invoke every tracked hub/test/*.ts once")
        )
    return findings


def scan_bytes(
    path: str,
    data: bytes,
    *,
    source_path: str | None = None,
    expected_test_paths: frozenset[str] | None = None,
) -> list[Finding]:
    """Scan one file as inert bytes; never import or evaluate its contents."""
    findings: list[Finding] = []
    for rule, needle in EXACT_IOCS:
        start = 0
        while True:
            offset = data.find(needle, start)
            if offset < 0:
                break
            findings.append(_finding(path, data, rule, offset, f"matched {len(needle)}-byte IOC"))
            start = offset + len(needle)

    findings.extend(_scan_lockfile(path, data, source_path=source_path))
    findings.extend(
        _scan_release_manifest(
            path,
            data,
            source_path=source_path,
            expected_test_paths=expected_test_paths,
        )
    )
    executable_path = PurePosixPath(path if source_path is None else source_path)
    if not _is_executable_source(executable_path, data):
        return findings

    shim_offset = data.find(INJECTED_REQUIRE_SHIM)
    if shim_offset >= 0:
        findings.append(_finding(path, data, "injected-require-shim", shim_offset, "unexpected createRequire ESM shim"))

    eval_match = EVAL_RE.search(data)
    decode_match = DECODE_RE.search(data)
    if eval_match and decode_match:
        findings.append(
            _finding(path, data, "dynamic-decoder", eval_match.start(), "eval combined with base64 decoding")
        )

    constructor_match = FUNCTION_CONSTRUCTOR_RE.search(data)
    if constructor_match:
        findings.append(
            _finding(path, data, "function-constructor", constructor_match.start(), "dynamic Function construction")
        )

    padding_match = HORIZONTAL_PADDING_RE.search(data)
    if padding_match:
        findings.append(
            _finding(
                path,
                data,
                "horizontal-padding",
                padding_match.start(),
                f"run is {len(padding_match.group(0))} bytes (limit {MAX_HORIZONTAL_WHITESPACE})",
            )
        )

    offset = 0
    for line_number, line in enumerate(data.splitlines(keepends=True), start=1):
        physical_length = len(line.rstrip(b"\r\n"))
        if physical_length > MAX_PHYSICAL_LINE:
            findings.append(
                Finding(
                    path,
                    "oversized-line",
                    offset,
                    line_number,
                    1,
                    f"line is {physical_length} bytes (limit {MAX_PHYSICAL_LINE})",
                )
            )
            break
        offset += len(line)
    return findings


def _run_git(root: Path, arguments: Sequence[str], *, stdin: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", "replace").strip()
        raise ScanError(f"git {' '.join(arguments)} failed: {error}")
    return result.stdout


def _tracked_paths(root: Path) -> list[Path]:
    output = _run_git(root, ["ls-files", "-z"])
    return [root / item.decode("utf-8", "surrogateescape") for item in output.split(b"\0") if item]


def _display_path(path: str) -> str:
    """Render arbitrary Git path bytes without letting control bytes forge output lines."""
    return ascii(path)[1:-1]


def _whole_tree_paths(root: Path) -> list[Path]:
    paths: list[Path] = []
    for directory, child_directories, filenames in os.walk(root):
        child_directories[:] = sorted(name for name in child_directories if name not in SKIP_DIRECTORIES)
        for filename in sorted(filenames):
            paths.append(Path(directory) / filename)
    return paths


def scan_worktree(root: Path, *, whole_tree: bool = False) -> tuple[list[Finding], int]:
    tracked_paths = _tracked_paths(root)
    paths = _whole_tree_paths(root) if whole_tree else tracked_paths
    expected_test_paths = frozenset(
        path.relative_to(root / "hub").as_posix()
        for path in tracked_paths
        if path.parent == root / "hub" / "test" and path.suffix == ".ts"
    )
    findings: list[Finding] = []
    scanned = 0
    for path in paths:
        if path.is_symlink():
            data = os.readlink(path).encode("utf-8", "surrogateescape")
        elif path.is_file():
            data = path.read_bytes()
        else:
            continue
        relative = path.relative_to(root).as_posix()
        findings.extend(
            scan_bytes(
                _display_path(relative),
                data,
                source_path=relative,
                expected_test_paths=expected_test_paths,
            )
        )
        scanned += 1
    return findings, scanned


def _history_blob_paths(root: Path) -> dict[str, set[str]]:
    """Map blobs to every reachable tree path, preserving arbitrary filename bytes."""
    raw_trees = _run_git(root, ["log", "--all", "--format=%T"])
    tree_oids = {line.decode("ascii") for line in raw_trees.splitlines() if line}
    names: dict[str, set[str]] = {}
    for tree_oid in sorted(tree_oids):
        entries = _run_git(root, ["ls-tree", "-r", "-z", "--full-tree", tree_oid])
        for entry in entries.split(b"\0"):
            if not entry:
                continue
            metadata, separator, raw_path = entry.partition(b"\t")
            fields = metadata.split(b" ")
            if not separator or len(fields) != 3:
                raise ScanError(f"malformed ls-tree entry in {tree_oid}")
            _mode, object_type, raw_oid = fields
            if object_type != b"blob":
                continue
            oid = raw_oid.decode("ascii")
            names.setdefault(oid, set()).add(raw_path.decode("utf-8", "surrogateescape"))
    return names


def _history_blobs(root: Path) -> Iterable[tuple[str, tuple[str, ...], bytes]]:
    # Object names are deliberately disabled here. Tree enumeration above is
    # NUL-delimited; parsing rev-list's quoted display names would be unsafe.
    objects = _run_git(root, ["rev-list", "--objects", "--no-object-names", "--all"])
    oids = [raw_oid.decode("ascii") for raw_oid in objects.splitlines() if raw_oid]
    names = _history_blob_paths(root)
    checks = _run_git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], stdin=("\n".join(oids) + "\n").encode())
    for raw_line in checks.splitlines():
        oid, object_type = raw_line.decode("ascii").split()
        if object_type != "blob":
            continue
        paths = tuple(sorted(names.get(oid, {"<unnamed>"}), key=os.fsencode))
        yield oid, paths, _run_git(root, ["cat-file", "blob", oid])


def scan_history(root: Path) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    scanned = 0
    for oid, paths, data in _history_blobs(root):
        seen: set[tuple[str, int, str]] = set()
        for path in paths:
            decorated_path = f"{_display_path(path)}@{oid[:12]}"
            for finding in scan_bytes(decorated_path, data, source_path=path):
                key = (finding.rule, finding.offset, finding.detail)
                if key not in seen:
                    findings.append(finding)
                    seen.add(key)
        scanned += 1
    return findings, scanned


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=REPO_ROOT, help="repository root (default: script parent)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--whole-tree", action="store_true", help="also scan ignored/generated files, excluding dependency dirs")
    mode.add_argument("--all-history", action="store_true", help="scan every blob reachable from local refs")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    root = args.repo.resolve()
    try:
        findings, scanned = scan_history(root) if args.all_history else scan_worktree(root, whole_tree=args.whole_tree)
    except (OSError, ScanError) as exc:
        print(f"source-integrity: ERROR: {exc}", file=sys.stderr)
        return 2

    if findings:
        for finding in findings:
            print(finding.render(), file=sys.stderr)
        print(f"source-integrity: FAILED ({len(findings)} finding(s), {scanned} file/blob(s) scanned)", file=sys.stderr)
        return 1

    scope = "reachable history" if args.all_history else ("whole worktree" if args.whole_tree else "tracked worktree")
    print(f"source-integrity: OK ({scope}; {scanned} file/blob(s) scanned)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
