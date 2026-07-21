#!/usr/bin/env python3
"""Read-only static scanner for developer workspaces and npm installations.

The scanner never imports, evaluates, extracts, or executes scanned content. It
uses only the Python standard library and an optional, read-only `/usr/bin/git`
object walk. Findings never include source snippets or environment values.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import glob
import gzip
import hashlib
import heapq
import io
import json
import os
import re
import stat
import struct
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Iterable, Iterator, Mapping, Sequence, Union


SCANNER_VERSION = "1.0.0"
MIB = 1024 * 1024
SEVERITY_RANK = {"review": 1, "high": 2, "critical": 3}
FILE_RESULT_FINDING_LIMITS = {"review": 2048, "high": 1024, "critical": 1024}
FILE_RESULT_ISSUE_LIMIT = 4096
GLOBAL_FINDING_LIMITS = {"review": 40_000, "high": 5_000, "critical": 5_000}
GLOBAL_ISSUE_LIMIT = 10_000
MAX_PATH_CHARS = 4096
MAX_MESSAGE_CHARS = 2048

CODE_SUFFIXES = {
    ".bash",
    ".c",
    ".cc",
    ".cjs",
    ".clj",
    ".cljs",
    ".conf",
    ".cpp",
    ".cs",
    ".css",
    ".cts",
    ".cxx",
    ".dart",
    ".dockerfile",
    ".ejs",
    ".el",
    ".erl",
    ".ex",
    ".exs",
    ".fish",
    ".go",
    ".h",
    ".hpp",
    ".hrl",
    ".htm",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".json5",
    ".jsonc",
    ".jsx",
    ".kt",
    ".kts",
    ".less",
    ".lua",
    ".mjs",
    ".mts",
    ".php",
    ".pl",
    ".pm",
    ".ps1",
    ".py",
    ".r",
    ".rb",
    ".rs",
    ".sass",
    ".scala",
    ".scss",
    ".sh",
    ".sql",
    ".svelte",
    ".swift",
    ".toml",
    ".ts",
    ".tsx",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
    ".zsh",
}
SPECIAL_CODE_NAMES = {
    "Brewfile",
    "Containerfile",
    "Dockerfile",
    "Gemfile",
    "Justfile",
    "Makefile",
    "Procfile",
    "Rakefile",
    "deno.lock",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
}
TAR_ARCHIVE_SUFFIXES = (".tgz", ".tar", ".tar.gz")
ZIP_ARCHIVE_SUFFIXES = (".zip", ".vsix")
ARCHIVE_SUFFIXES = TAR_ARCHIVE_SUFFIXES + ZIP_ARCHIVE_SUFFIXES
ZIP_MAGICS = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
LIFECYCLE_NAMES = {
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
}


def _joined_bytes(*parts: bytes) -> bytes:
    """Keep live indicators split so the scanner cannot match its own source."""
    return b"".join(parts)


EXACT_BYTE_IOCS = (
    ("campaign-marker", _joined_bytes(b"global.", b"i='5-4-23'")),
    ("campaign-marker", _joined_bytes(b"global.", b"i='5-3-339'")),
    ("campaign-marker", _joined_bytes(b"global.", b"i='5-3-", b"339-du'")),
    ("npm-persistence-marker", _joined_bytes(b"C260", b"521A")),
    ("npm-persistence-marker", _joined_bytes(b"RS260", b"605")),
    ("obfuscator-marker", _joined_bytes(b"_$", b"_913e")),
    ("obfuscator-marker", _joined_bytes(b"_$", b"_2fdd")),
    ("encoded-loader-marker", _joined_bytes(b"dmFyIF8kXzJmZGQ9", b"KGZ1bmN0aW9u")),
    ("campaign-account", _joined_bytes(b"TCqf6ZkaQD84vYsC2", b"cuu1jRwB6JveTaRrF")),
    ("campaign-account", _joined_bytes(b"TFMryB9m6d4kBMRj", b"EVyFRbqKSV1cV2NcpH")),
    (
        "campaign-transaction",
        _joined_bytes(b"0x9d202c824402ca89e9aaccd2390b6f8b", b"332ae743caa1469c695feb2781d56519"),
    ),
    (
        "campaign-transaction",
        _joined_bytes(b"0x3d2075f97b7b1e3234bd653779d21c605", b"d7d8c6ec9c98d983880be5c7f4f9471"),
    ),
    ("campaign-key", _joined_bytes(b"2[gWfGj;<:-", b"93Z^C")),
    ("campaign-key", _joined_bytes(b"m6:tTh^D)c", b"Bz?NM]")),
)

KNOWN_MALICIOUS_SHA256: Mapping[str, str] = {
    "5f1cb407a87340982de3ff5b86a232edb1fcf5e23fc8c72c74368ecef679e14b": "verified infected npm CLI",
    "4fa92abafc00559cb4e0440a148f39367e7486f58788559dd4dac64f66db606c": "verified injected source blob",
    "84f711174b4ca84a08369e293fe89c44aa6b417178bf3b9dbc42449dfc40534c": "historical reported VS Code member IOC",
}
KNOWN_MALICIOUS_GIT_OIDS = {
    "df12fbc86fd07aa346d25e2037c60dc7d9aff9ae",
    "69bfda2b6b75adff7c641ef4f5c2425aead6a6d0",
    "027bfe225666e5ea38ac4e81ec1f0fff7a569998",
    "5c2b9ab206895ea31faccd74a28e274e4811c5e2",
}

EVAL_RE = re.compile(rb"\beval\s*\(")
DECODE_RE = re.compile(
    rb"\batob\s*\(|\bBuffer\s*\.\s*from\s*\([^\n]{0,512}\bbase64\b|\bbase64\s*(?:-d|--decode)",
    re.IGNORECASE,
)
FUNCTION_RE = re.compile(
    rb"\b(?:new\s+)?Function\s*\(|\bFunction\s*\.\s*constructor\b|\[['\"]constructor['\"]\]"
)
HORIZONTAL_PADDING_RE = re.compile(rb"[ \t]{128,}(?=\S)")
VERTICAL_PADDING_RE = re.compile(rb"(?:[ \t]*\r?\n){64,}(?=\S)")
BASE64_BLOB_RE = re.compile(rb"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{512,}={0,2}(?![A-Za-z0-9+/])")
CREATE_REQUIRE = _joined_bytes(
    b"create", b"Require(import.meta.url)"
)
DETACHED_RE = re.compile(rb"\bdetached\s*:\s*true\b")
STDIO_IGNORE_RE = re.compile(rb"\bstdio\s*:\s*['\"]ignore['\"]")
NODE_INLINE_RE = re.compile(rb"['\"]node['\"][^\n]{0,256}['\"]-e['\"]")
UNICODE_CONTROL_RE = re.compile(
    b"(?:\xe2\x80[\x8b-\x8f\xaa-\xae]|\xe2\x81[\xa6-\xa9]|\xef\xbb\xbf)"
)

C2_ENDPOINT_TOKENS = (
    _joined_bytes(b"api.", b"trongrid.io"),
    _joined_bytes(b"fullnode.mainnet.", b"aptoslabs.com"),
    _joined_bytes(b"bsc-dataseed.", b"binance.org"),
    _joined_bytes(b"bsc-rpc.", b"publicnode.com"),
)
C2_METHOD_TOKENS = (
    _joined_bytes(b"eth_getTransaction", b"ByHash"),
    _joined_bytes(b"eth_getBlock", b"ByNumber"),
)

NETWORK_COMMAND_RE = re.compile(
    r"(?:\bcurl\b|\bwget\b|https?://|fetch\s*\(|axios\s*\.|socket\.io)", re.IGNORECASE
)
DECODE_COMMAND_RE = re.compile(r"(?:\batob\b|base64|Buffer\.from|fromCharCode)", re.IGNORECASE)
EXECUTE_COMMAND_RE = re.compile(
    r"(?:\beval\b|\bnode\s+-e\b|\b(?:ba|z|fi)?sh\s+-c\b|\|\s*(?:ba|z|fi)?sh\b|new\s+Function)",
    re.IGNORECASE,
)
PERSIST_COMMAND_RE = re.compile(
    r"(?:LaunchAgents?|LaunchDaemons?|crontab|\.vscode[/\\]tasks\.json|npmrc|~[/\\]\.node_modules)",
    re.IGNORECASE,
)
CREDENTIAL_COMMAND_RE = re.compile(
    r"(?:1Password|Keychain|Login Data|Local State|Cookies|\.ssh|_sysenv|process\.env)", re.IGNORECASE
)
REWRITE_COMMAND_RE = re.compile(
    r"(?:\bfind\b[^\n]*(?:\.js|\.ts)|\bsed\s+-i\b|writeFile(?:Sync)?\s*\(|appendFile(?:Sync)?\s*\()",
    re.IGNORECASE,
)


def _bounded_text(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    digest = hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()[:16]
    return f"{value[:limit]}...[truncated chars={len(value)} sha256={digest}]"


def _terminal_quote(value: object) -> str:
    return json.dumps(str(value), ensure_ascii=True)


@dataclasses.dataclass(frozen=True)
class Finding:
    path: str
    rule_id: str
    severity: str
    detail: str
    offset: int = 0
    line: int = 1
    column: int = 1
    sha256: str | None = None
    git_oid: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", _bounded_text(self.path, MAX_PATH_CHARS))
        object.__setattr__(self, "rule_id", _bounded_text(self.rule_id, 128))
        object.__setattr__(self, "detail", _bounded_text(self.detail, MAX_MESSAGE_CHARS))

    def sort_key(self) -> tuple[object, ...]:
        return (-SEVERITY_RANK[self.severity], os.fsencode(self.path), self.offset, self.rule_id)

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "path": self.path,
            "rule_id": self.rule_id,
            "severity": self.severity,
            "detail": self.detail,
            "offset": self.offset,
            "line": self.line,
            "column": self.column,
        }
        if self.sha256 is not None:
            result["sha256"] = self.sha256
        if self.git_oid is not None:
            result["git_oid"] = self.git_oid
        return result

    def render(self) -> str:
        safe_path = _terminal_quote(self.path)
        digest = f" sha256={_terminal_quote(self.sha256)}" if self.sha256 else ""
        oid = f" git_oid={_terminal_quote(self.git_oid)}" if self.git_oid else ""
        return (
            f"{self.severity.upper():8} {safe_path}:{self.line}:{self.column} "
            f"rule={_terminal_quote(self.rule_id)} detail={_terminal_quote(self.detail)}{digest}{oid}"
        )


@dataclasses.dataclass(frozen=True)
class ScanIssue:
    path: str
    operation: str
    error: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", _bounded_text(self.path, MAX_PATH_CHARS))
        object.__setattr__(self, "operation", _bounded_text(self.operation, 128))
        object.__setattr__(self, "error", _bounded_text(self.error, MAX_MESSAGE_CHARS))

    def as_dict(self) -> dict[str, str]:
        return dataclasses.asdict(self)

    def render(self) -> str:
        return (
            f"INCOMPLETE {_terminal_quote(self.path)} "
            f"operation={_terminal_quote(self.operation)} error={_terminal_quote(self.error)}"
        )


@dataclasses.dataclass
class Analysis:
    findings: list[Finding] = dataclasses.field(default_factory=list)
    lifecycle_scripts: int = 0


@dataclasses.dataclass
class FileResult:
    findings: list[Finding] = dataclasses.field(default_factory=list)
    issues: list[ScanIssue] = dataclasses.field(default_factory=list)
    bytes_scanned: int = 0
    files_scanned: int = 0
    archives_scanned: int = 0
    archive_members_scanned: int = 0
    lifecycle_scripts: int = 0
    findings_omitted: int = 0
    issues_omitted: int = 0
    finding_samples_by_severity: dict[str, int] = dataclasses.field(
        default_factory=lambda: {severity: 0 for severity in SEVERITY_RANK}
    )


def _result_add_findings(result: FileResult, findings: Iterable[Finding]) -> None:
    for finding in findings:
        severity = finding.severity
        if result.finding_samples_by_severity[severity] < FILE_RESULT_FINDING_LIMITS[severity]:
            result.findings.append(finding)
            result.finding_samples_by_severity[severity] += 1
        else:
            result.findings_omitted += 1


def _result_add_issues(result: FileResult, issues: Iterable[ScanIssue]) -> None:
    for issue in issues:
        if len(result.issues) < FILE_RESULT_ISSUE_LIMIT:
            result.issues.append(issue)
        else:
            result.issues_omitted += 1


@dataclasses.dataclass
class OpenFile:
    """A regular file opened relative to a held directory descriptor."""

    path: Path
    descriptor: int
    initial_stat: os.stat_result


@dataclasses.dataclass
class DirectoryFrame:
    path: Path
    descriptor: int
    names: list[str]
    index: int = 0


@dataclasses.dataclass
class ScanStats:
    files_seen: int = 0
    files_scanned: int = 0
    bytes_scanned: int = 0
    non_code_skipped: int = 0
    duplicate_inodes_skipped: int = 0
    symlinks_not_followed: int = 0
    special_files_skipped: int = 0
    archives_scanned: int = 0
    archive_members_scanned: int = 0
    lifecycle_scripts: int = 0
    git_repository_paths_discovered: int = 0
    git_repositories: int = 0
    git_blobs_scanned: int = 0
    findings_omitted: int = 0
    issues_omitted: int = 0


@dataclasses.dataclass(frozen=True)
class ScanConfig:
    max_file_bytes: int = 128 * MIB
    max_archive_member_bytes: int = 32 * MIB
    max_archive_total_bytes: int = 256 * MIB
    max_archive_members: int = 20_000
    max_archive_ratio: int = 200
    max_archive_depth: int = 2
    include_lifecycle_inventory: bool = False
    scan_archives: bool = True


@dataclasses.dataclass
class ArchiveBudget:
    remaining_bytes: int
    remaining_members: int


def _archive_budget(config: ScanConfig) -> ArchiveBudget:
    return ArchiveBudget(config.max_archive_total_bytes, config.max_archive_members)


def _finding(
    path: str,
    data: bytes,
    rule_id: str,
    severity: str,
    offset: int,
    detail: str,
    digest: str,
    *,
    git_oid: str | None = None,
) -> Finding:
    return Finding(path, rule_id, severity, detail, offset, 1, 1, digest, git_oid)


def _attach_locations(data: bytes, findings: Sequence[Finding]) -> list[Finding]:
    """Attach locations after findings have been bounded and deduplicated."""
    locations: dict[int, tuple[int, int]] = {}
    cursor = 0
    line = 1
    line_start = 0
    for raw_offset in sorted({finding.offset for finding in findings}):
        offset = min(max(raw_offset, 0), len(data))
        line += data.count(b"\n", cursor, offset)
        last_newline = data.rfind(b"\n", cursor, offset)
        if last_newline >= 0:
            line_start = last_newline + 1
        locations[raw_offset] = (line, offset - line_start + 1)
        cursor = offset
    return [
        dataclasses.replace(
            finding,
            line=locations[finding.offset][0],
            column=locations[finding.offset][1],
        )
        for finding in findings
    ]


def _is_probably_binary(data: bytes) -> bool:
    return b"\0" in data[:8192]


def _requires_source_heuristics(path: str) -> bool:
    """Return true when a binary-looking blob still has source semantics."""
    normalized = path.split("!", 1)[-1].replace(os.sep, "/")
    pure = PurePosixPath(normalized)
    if pure.name in SPECIAL_CODE_NAMES or pure.suffix.lower() in CODE_SUFFIXES:
        return True
    if re.search(r"@[0-9a-f]{40,64}$", normalized):
        # An all-object Git walk has no reliable path for unreachable blobs.
        return True
    return not pure.suffix and pure.name not in {"LICENSE", "NOTICE", "README"}


def _is_code_path(path: str) -> bool:
    normalized = path.split("!", 1)[-1]
    pure = PurePosixPath(normalized.replace(os.sep, "/"))
    name = pure.name
    lowered = name.lower()
    if name in SPECIAL_CODE_NAMES or pure.suffix.lower() in CODE_SUFFIXES:
        return True
    if lowered.endswith(ARCHIVE_SUFFIXES) or lowered.endswith((".asar", ".vsix")):
        return True
    if not pure.suffix and name not in {"LICENSE", "NOTICE", "README"}:
        return True
    return False


def _all_occurrences(data: bytes, needle: bytes) -> Iterator[int]:
    start = 0
    while True:
        offset = data.find(needle, start)
        if offset < 0:
            return
        yield offset
        start = offset + max(1, len(needle))


Signal = Union[bytes, re.Pattern[bytes]]


def _signal_offsets(data: bytes, signal: Signal) -> Iterator[int]:
    if isinstance(signal, bytes):
        yield from _all_occurrences(data, signal)
        return
    for match in signal.finditer(data):
        yield match.start()


def _group_offsets(data: bytes, signals: Sequence[Signal]) -> Iterator[int]:
    yield from heapq.merge(*(_signal_offsets(data, signal) for signal in signals))


def _first_group_offset(data: bytes, signals: Sequence[Signal]) -> int | None:
    return next(_group_offsets(data, signals), None)


def _cluster_signals(data: bytes, groups: Sequence[Sequence[Signal]], max_span: int) -> int | None:
    """Find a compact signal cluster with bounded memory, including at file tail."""
    if not groups:
        return None

    def tagged(group_index: int, signals: Sequence[Signal]) -> Iterator[tuple[int, int]]:
        for offset in _group_offsets(data, signals):
            yield offset, group_index

    last_seen: list[int | None] = [None] * len(groups)
    streams = [tagged(index, group) for index, group in enumerate(groups)]
    for offset, group_index in heapq.merge(*streams):
        last_seen[group_index] = offset
        if all(value is not None for value in last_seen):
            concrete = [value for value in last_seen if value is not None]
            if max(concrete) - min(concrete) <= max_span:
                return min(concrete)
    return None


def _package_manifest_findings(
    path: str,
    data: bytes,
    digest: str,
    *,
    include_inventory: bool,
) -> Analysis:
    analysis = Analysis()
    if PurePosixPath(path.split("!", 1)[-1].replace(os.sep, "/")).name != "package.json":
        return analysis
    try:
        document = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        analysis.findings.append(
            _finding(path, data, "invalid-package-json", "review", 0, f"JSON parse failed: {exc.__class__.__name__}", digest)
        )
        return analysis
    if not isinstance(document, dict):
        return analysis

    normalized_path = path.replace("\\", "/")
    dependencies = document.get("dependencies")
    if normalized_path.endswith("/.node_modules/package.json") and isinstance(dependencies, dict):
        if set(dependencies) == {"axios", "socket.io-client"}:
            analysis.findings.append(
                _finding(
                    path,
                    data,
                    "hidden-home-node-runtime",
                    "high",
                    0,
                    "hidden home runtime has the incident-specific dependency pair",
                    digest,
                )
            )

    scripts = document.get("scripts")
    if not isinstance(scripts, dict):
        return analysis
    for name in sorted(LIFECYCLE_NAMES.intersection(scripts)):
        command = scripts.get(name)
        if not isinstance(command, str):
            continue
        analysis.lifecycle_scripts += 1
        categories: list[str] = []
        if NETWORK_COMMAND_RE.search(command):
            categories.append("network")
        if DECODE_COMMAND_RE.search(command):
            categories.append("decode")
        if EXECUTE_COMMAND_RE.search(command):
            categories.append("dynamic-exec")
        if PERSIST_COMMAND_RE.search(command):
            categories.append("persistence")
        if CREDENTIAL_COMMAND_RE.search(command):
            categories.append("credential-access")
        if REWRITE_COMMAND_RE.search(command):
            categories.append("recursive-rewrite")
        if "/tmp/.npm" in command:
            categories.append("incident-staging")

        dangerous_pair = (
            {"network", "dynamic-exec"}.issubset(categories)
            or {"decode", "dynamic-exec"}.issubset(categories)
            or {"persistence", "dynamic-exec"}.issubset(categories)
            or {"credential-access", "network"}.issubset(categories)
            or "incident-staging" in categories
        )
        if dangerous_pair:
            analysis.findings.append(
                _finding(
                    path,
                    data,
                    "suspicious-lifecycle-script",
                    "high",
                    0,
                    f"{name} combines: {', '.join(categories)}",
                    digest,
                )
            )
        elif categories or include_inventory:
            detail = f"{name} lifecycle present"
            if categories:
                detail += f"; review signals: {', '.join(categories)}"
            analysis.findings.append(
                _finding(path, data, "lifecycle-script-review", "review", 0, detail, digest)
            )
    return analysis


def _lockfile_findings(
    path: str,
    data: bytes,
    digest: str,
    *,
    include_inventory: bool,
) -> list[Finding]:
    name = PurePosixPath(path.split("!", 1)[-1].replace(os.sep, "/")).name
    if name not in {"package-lock.json", "npm-shrinkwrap.json"}:
        return []
    try:
        document = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return []
    if not isinstance(document, dict) or not isinstance(document.get("packages"), dict):
        return []
    findings: list[Finding] = []
    counts_by_rule: dict[str, int] = {}

    def add(finding: Finding) -> None:
        count = counts_by_rule.get(finding.rule_id, 0)
        if count < 16:
            findings.append(finding)
            counts_by_rule[finding.rule_id] = count + 1

    for package_path, metadata in document["packages"].items():
        if not isinstance(package_path, str) or not isinstance(metadata, dict):
            continue
        has_script = metadata.get("hasInstallScript") is True
        resolved = metadata.get("resolved")
        integrity = metadata.get("integrity")
        if include_inventory and has_script:
            add(
                _finding(
                    path,
                    data,
                    "lockfile-install-script-review",
                    "review",
                    0,
                    f"{package_path or '<root>'} declares an install lifecycle",
                    digest,
                )
            )
        if isinstance(resolved, str) and not (
            resolved.startswith("https://registry.npmjs.org/")
            or resolved.startswith("https://registry.yarnpkg.com/")
            or resolved.startswith("file:")
        ):
            add(
                _finding(
                    path,
                    data,
                    "lockfile-non-registry-source",
                    "review",
                    0,
                    f"{package_path or '<root>'} resolves outside the standard npm registries",
                    digest,
                )
            )
        if include_inventory and isinstance(resolved, str) and resolved.startswith("https://") and not integrity:
            add(
                _finding(
                    path,
                    data,
                    "lockfile-missing-integrity-review",
                    "review",
                    0,
                    f"{package_path or '<root>'} has no integrity value",
                    digest,
                )
            )
    return findings


def _vscode_task_findings(path: str, data: bytes, digest: str) -> list[Finding]:
    normalized = path.replace("\\", "/")
    if not normalized.endswith("/.vscode/tasks.json"):
        return []
    folder_open_pattern = re.compile(rb"['\"]runOn['\"]\s*:\s*['\"]folderOpen['\"]")
    folder_open = folder_open_pattern.search(data)
    if folder_open is None:
        return []
    try:
        document = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return [
            _finding(
                path,
                data,
                "vscode-folder-open-task",
                "review",
                folder_open.start(),
                "automatic folder-open task present; JSONC requires manual review",
                digest,
            )
        ]
    tasks = document.get("tasks") if isinstance(document, dict) else None
    if not isinstance(tasks, list):
        return []
    executable_pattern = re.compile(r"\b(?:node|npm|npx|curl|wget|bash|zsh|sh)\b", re.IGNORECASE)
    saw_folder_open = False
    for task in tasks:
        if not isinstance(task, dict):
            continue
        run_options = task.get("runOptions")
        if not isinstance(run_options, dict) or run_options.get("runOn") != "folderOpen":
            continue
        saw_folder_open = True
        serialized = json.dumps(task, ensure_ascii=True, sort_keys=True)
        if executable_pattern.search(serialized):
            return [
                _finding(
                    path,
                    data,
                    "vscode-folder-open-task",
                    "high",
                    folder_open.start(),
                    "automatic folder-open task invokes an executable",
                    digest,
                )
            ]
    if saw_folder_open:
        return [
            _finding(
                path,
                data,
                "vscode-folder-open-task",
                "review",
                folder_open.start(),
                "automatic folder-open task present",
                digest,
            )
        ]
    return []


def analyze_bytes(
    path: str,
    data: bytes,
    *,
    include_lifecycle_inventory: bool = False,
    git_oid: str | None = None,
) -> Analysis:
    """Analyze inert bytes. This function never imports or evaluates content."""
    digest = hashlib.sha256(data).hexdigest()
    findings: list[Finding] = []

    known_hash = KNOWN_MALICIOUS_SHA256.get(digest)
    if known_hash:
        findings.append(Finding(path, "known-malicious-sha256", "critical", known_hash, sha256=digest, git_oid=git_oid))
    if git_oid in KNOWN_MALICIOUS_GIT_OIDS:
        findings.append(
            Finding(
                path,
                "known-malicious-git-object",
                "critical",
                "Git object matches a verified incident blob",
                sha256=digest,
                git_oid=git_oid,
            )
        )

    for rule_id, needle in EXACT_BYTE_IOCS:
        offset = data.find(needle)
        if offset >= 0:
            findings.append(
                _finding(path, data, rule_id, "critical", offset, f"matched {len(needle)}-byte incident IOC", digest, git_oid=git_oid)
            )

    # Binary containers still receive exact IOC and hash checks, but source
    # heuristics would be meaningless and noisy on their encoded bytes.
    if _is_probably_binary(data) and not _requires_source_heuristics(path):
        return Analysis(findings=_attach_locations(data, findings))

    padding_signals: tuple[Signal, ...] = (HORIZONTAL_PADDING_RE, VERTICAL_PADDING_RE)
    encoded_or_decoded_signals: tuple[Signal, ...] = (DECODE_RE, BASE64_BLOB_RE)
    dynamic_signals: tuple[Signal, ...] = (EVAL_RE, DECODE_RE, DETACHED_RE)
    endpoint_hits = [(token, data.find(token)) for token in C2_ENDPOINT_TOKENS if data.find(token) >= 0]
    method_hits = [(token, data.find(token)) for token in C2_METHOD_TOKENS if data.find(token) >= 0]

    padding_offset = _first_group_offset(data, padding_signals)
    dynamic_decoder = _cluster_signals(data, [(EVAL_RE,), (DECODE_RE,)], 16 * 1024)
    hidden_dynamic_loader = _cluster_signals(
        data,
        [(EVAL_RE,), (DECODE_RE,), padding_signals],
        128 * 1024,
    )
    if hidden_dynamic_loader is not None:
        findings.append(
            _finding(
                path,
                data,
                "hidden-dynamic-loader",
                "high",
                hidden_dynamic_loader,
                "dynamic decoder is combined with hidden horizontal/vertical padding",
                digest,
                git_oid=git_oid,
            )
        )
    elif dynamic_decoder is not None:
        findings.append(
            _finding(
                path,
                data,
                "dynamic-decoder-review",
                "review",
                dynamic_decoder,
                "eval is combined with base64 decoding",
                digest,
                git_oid=git_oid,
            )
        )

    function_loader = _cluster_signals(
        data,
        [(FUNCTION_RE,), encoded_or_decoded_signals, padding_signals],
        128 * 1024,
    )
    if function_loader is not None:
        findings.append(
            _finding(
                path,
                data,
                "obfuscated-function-loader",
                "high",
                function_loader,
                "dynamic Function, encoded data, and hidden padding occur together",
                digest,
                git_oid=git_oid,
            )
        )

    create_require_loader = _cluster_signals(data, [(CREATE_REQUIRE,), padding_signals], 128 * 1024)
    if create_require_loader is not None:
        findings.append(
            _finding(
                path,
                data,
                "padded-create-require-loader",
                "high",
                create_require_loader,
                "createRequire shim is combined with hidden padding",
                digest,
                git_oid=git_oid,
            )
        )

    detached_loader = _cluster_signals(
        data,
        [(DETACHED_RE,), (STDIO_IGNORE_RE,), (NODE_INLINE_RE,)],
        16 * 1024,
    )
    if detached_loader is not None:
        findings.append(
            _finding(
                path,
                data,
                "detached-node-loader",
                "high",
                detached_loader,
                "detached, ignored-stdio Node inline process launcher",
                digest,
                git_oid=git_oid,
            )
        )

    c2_loader_offset: int | None = None
    qualifying_c2_tokens: list[bytes] = []
    if len(endpoint_hits) >= 2:
        qualifying_c2_tokens = [token for token, _offset in endpoint_hits]
    elif endpoint_hits and method_hits:
        qualifying_c2_tokens = [endpoint_hits[0][0], method_hits[0][0]]
    if len(qualifying_c2_tokens) >= 2:
        for index, first in enumerate(qualifying_c2_tokens):
            for second in qualifying_c2_tokens[index + 1 :]:
                clustered = _cluster_signals(data, [(first,), (second,), dynamic_signals], 256 * 1024)
                if clustered is not None:
                    c2_loader_offset = clustered
                    break
            if c2_loader_offset is not None:
                break
    if c2_loader_offset is not None:
        findings.append(
            _finding(
                path,
                data,
                "blockchain-dead-drop-loader",
                "high",
                c2_loader_offset,
                f"{len(endpoint_hits)} chain endpoint and {len(method_hits)} RPC method indicators with dynamic execution",
                digest,
                git_oid=git_oid,
            )
        )
    elif len(method_hits) >= 2:
        rpc_review_offset = _cluster_signals(
            data,
            [(method_hits[0][0],), (method_hits[1][0],), dynamic_signals],
            256 * 1024,
        )
        if rpc_review_offset is not None:
            findings.append(
                _finding(
                    path,
                    data,
                    "blockchain-rpc-review",
                    "review",
                    rpc_review_offset,
                    "common Ethereum RPC methods occur near dynamic code without an incident chain endpoint",
                    digest,
                    git_oid=git_oid,
                )
            )

    if padding_offset is not None and not any(f.rule_id in {"hidden-dynamic-loader", "obfuscated-function-loader", "padded-create-require-loader"} for f in findings):
        findings.append(
            _finding(
                path,
                data,
                "hidden-padding-review",
                "review",
                padding_offset,
                "long whitespace padding before executable content",
                digest,
                git_oid=git_oid,
            )
        )

    control = UNICODE_CONTROL_RE.search(data)
    if control:
        findings.append(
            _finding(
                path,
                data,
                "unicode-control-review",
                "review",
                control.start(),
                "invisible or bidirectional Unicode control in source",
                digest,
                git_oid=git_oid,
            )
        )

    manifest = _package_manifest_findings(
        path,
        data,
        digest,
        include_inventory=include_lifecycle_inventory,
    )
    findings.extend(manifest.findings)
    findings.extend(
        _lockfile_findings(
            path,
            data,
            digest,
            include_inventory=include_lifecycle_inventory,
        )
    )
    findings.extend(_vscode_task_findings(path, data, digest))

    unique: dict[tuple[str, int, str], Finding] = {}
    for finding in findings:
        unique[(finding.rule_id, finding.offset, finding.severity)] = finding
    bounded = sorted(unique.values(), key=Finding.sort_key)[:128]
    return Analysis(findings=_attach_locations(data, bounded), lifecycle_scripts=manifest.lifecycle_scripts)


def scan_bytes(
    path: str,
    data: bytes,
    *,
    include_lifecycle_inventory: bool = False,
    git_oid: str | None = None,
) -> list[Finding]:
    """Public fixture-friendly wrapper around :func:`analyze_bytes`."""
    return analyze_bytes(
        path,
        data,
        include_lifecycle_inventory=include_lifecycle_inventory,
        git_oid=git_oid,
    ).findings


def _path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _is_archive_path(path: str, data: bytes) -> bool:
    lowered = path.lower()
    if lowered.endswith(ARCHIVE_SUFFIXES):
        return True
    # npm cacache blobs have no extension. Gzip and tar magic are enough to
    # attempt tarfile parsing; a failed parse is treated as an ordinary blob.
    return (
        data.startswith(b"\x1f\x8b")
        or data.startswith(ZIP_MAGICS)
        or (len(data) > 265 and data[257:262] == b"ustar")
    )


def _safe_read_open_file(open_file: OpenFile, max_bytes: int) -> tuple[bytes | None, ScanIssue | None]:
    path = open_file.path
    descriptor = open_file.descriptor
    before = open_file.initial_stat
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            return None, ScanIssue(str(path), "open", "path is no longer a regular file")
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            return None, ScanIssue(str(path), "race-check", "path changed before open completed")
        if opened.st_size > max_bytes:
            return None, ScanIssue(str(path), "size-limit", f"{opened.st_size} bytes exceeds limit {max_bytes}")
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(MIB, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            return None, ScanIssue(str(path), "size-limit", f"file grew beyond limit {max_bytes}")
        after_fd = os.fstat(descriptor)
    except OSError as exc:
        return None, ScanIssue(str(path), "read", f"{exc.__class__.__name__}: {exc}")
    finally:
        os.close(descriptor)
    identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    fd_after = (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns)
    if identity_before != fd_after:
        return None, ScanIssue(str(path), "race-check", "file changed while it was being scanned")
    return data, None


class ArchiveExpansionLimit(RuntimeError):
    """A compressed stream exceeded the permitted expanded byte budget."""


class _LimitedReader:
    def __init__(self, raw: object, limit: int) -> None:
        self.raw = raw
        self.limit = limit
        self.consumed = 0

    def read(self, size: int = -1) -> bytes:
        remaining = self.limit - self.consumed
        if remaining < 0:
            raise ArchiveExpansionLimit(f"expanded stream exceeds {self.limit} bytes")
        requested = remaining + 1 if size < 0 else min(size, remaining + 1)
        chunk = self.raw.read(requested)  # type: ignore[attr-defined]
        self.consumed += len(chunk)
        if self.consumed > self.limit:
            raise ArchiveExpansionLimit(f"expanded stream exceeds {self.limit} bytes")
        return chunk


def _unsafe_archive_member_name(name: str) -> bool:
    if "\0" in name:
        return True
    normalized = name.replace("\\", "/")
    if normalized.startswith(("/", "//")) or re.match(r"^[A-Za-z]:/", normalized):
        return True
    return ".." in PurePosixPath(normalized).parts


def _merge_archive_result(target: FileResult, nested: FileResult) -> None:
    _result_add_findings(target, nested.findings)
    _result_add_issues(target, nested.issues)
    target.findings_omitted += nested.findings_omitted
    target.issues_omitted += nested.issues_omitted
    target.bytes_scanned += nested.bytes_scanned
    target.archives_scanned += nested.archives_scanned
    target.archive_members_scanned += nested.archive_members_scanned
    target.lifecycle_scripts += nested.lifecycle_scripts


def _scan_tar_bytes(
    path: str,
    data: bytes,
    config: ScanConfig,
    *,
    depth: int = 0,
    budget: ArchiveBudget | None = None,
) -> FileResult:
    result = FileResult()
    if budget is None:
        budget = _archive_budget(config)
    if data.startswith(b"\x1f\x8b") and len(data) >= 4:
        reported_expanded = int.from_bytes(data[-4:], "little")
        metadata_budget = config.max_archive_members * 1024 + MIB
        container_limit = config.max_archive_total_bytes + metadata_budget
        if reported_expanded > container_limit or (
            len(data) > 0 and reported_expanded > len(data) * config.max_archive_ratio
        ):
            _result_add_issues(result, [
                ScanIssue(
                    path,
                    "archive-expansion-limit",
                    f"gzip reports {reported_expanded} expanded bytes for {len(data)} compressed bytes",
                )
            ])
            return result

    compressed_stream: io.BytesIO | None = None
    decompressed_stream: gzip.GzipFile | None = None
    expanded_stream: object
    archive_mode = "r|*"
    if data.startswith(b"\x1f\x8b"):
        compressed_stream = io.BytesIO(data)
        decompressed_stream = gzip.GzipFile(fileobj=compressed_stream, mode="rb")
        expanded_stream = _LimitedReader(
            decompressed_stream,
            min(config.max_archive_total_bytes, budget.remaining_bytes)
            + min(config.max_archive_members, budget.remaining_members) * 1024
            + MIB,
        )
        archive_mode = "r|"
    else:
        expanded_stream = io.BytesIO(data)
    try:
        archive = tarfile.open(fileobj=expanded_stream, mode=archive_mode)
    except ArchiveExpansionLimit as exc:
        if decompressed_stream is not None:
            decompressed_stream.close()
        if compressed_stream is not None:
            compressed_stream.close()
        _result_add_issues(result, [ScanIssue(path, "archive-expansion-limit", str(exc))])
        return result
    except (tarfile.TarError, OSError, EOFError) as exc:
        if decompressed_stream is not None:
            decompressed_stream.close()
        if compressed_stream is not None:
            compressed_stream.close()
        named_tar = path.lower().endswith(TAR_ARCHIVE_SUFFIXES)
        if data.startswith(b"\x1f\x8b") and not named_tar:
            return _scan_plain_gzip_bytes(path, data, config, budget=budget)
        _result_add_issues(result, [ScanIssue(path, "archive-open", f"{exc.__class__.__name__}: {exc}")])
        return result
    result.archives_scanned = 1
    total_unpacked = 0
    try:
        for member_count, member in enumerate(archive, start=1):
            if member_count > config.max_archive_members:
                _result_add_issues(result, [
                    ScanIssue(path, "archive-limit", f"member count exceeds limit {config.max_archive_members}")
                ])
                break
            if _unsafe_archive_member_name(member.name):
                _result_add_findings(result, [
                    Finding(
                        f"{path}!{member.name}",
                        "archive-path-traversal",
                        "high",
                        "archive member name escapes its logical root",
                    )
                ])
            if not member.isfile():
                continue
            if member.size > config.max_archive_member_bytes:
                _result_add_issues(result, [
                    ScanIssue(
                        f"{path}!{member.name}",
                        "archive-member-limit",
                        f"{member.size} bytes exceeds limit {config.max_archive_member_bytes}",
                    )
                ])
                continue
            if budget.remaining_members <= 0:
                _result_add_issues(
                    result,
                    [ScanIssue(path, "archive-limit", "nested archive member budget exhausted")],
                )
                break
            if member.size > budget.remaining_bytes:
                _result_add_issues(
                    result,
                    [ScanIssue(path, "archive-total-limit", "nested archive byte budget exhausted")],
                )
                break
            total_unpacked += member.size
            if total_unpacked > config.max_archive_total_bytes:
                _result_add_issues(result, [
                    ScanIssue(path, "archive-total-limit", f"expanded bytes exceed {config.max_archive_total_bytes}")
                ])
                break
            budget.remaining_members -= 1
            budget.remaining_bytes -= member.size
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            try:
                member_data = extracted.read(config.max_archive_member_bytes + 1)
            finally:
                extracted.close()
            if len(member_data) != member.size:
                _result_add_issues(result, [
                    ScanIssue(f"{path}!{member.name}", "archive-read", "member size changed or was truncated")
                ])
                continue
            virtual_path = f"{path}!{member.name}"
            analysis = analyze_bytes(
                virtual_path,
                member_data,
                include_lifecycle_inventory=config.include_lifecycle_inventory,
            )
            _result_add_findings(result, analysis.findings)
            result.lifecycle_scripts += analysis.lifecycle_scripts
            result.archive_members_scanned += 1
            result.bytes_scanned += len(member_data)
            if _is_archive_path(virtual_path, member_data):
                _merge_archive_result(
                    result,
                    _scan_archive_bytes(
                        virtual_path,
                        member_data,
                        config,
                        depth=depth + 1,
                        budget=budget,
                    ),
                )
    except ArchiveExpansionLimit as exc:
        _result_add_issues(result, [ScanIssue(path, "archive-expansion-limit", str(exc))])
    except (tarfile.TarError, OSError, EOFError) as exc:
        _result_add_issues(result, [ScanIssue(path, "archive-read", f"{exc.__class__.__name__}: {exc}")])
    finally:
        archive.close()
        if decompressed_stream is not None:
            decompressed_stream.close()
        if compressed_stream is not None:
            compressed_stream.close()
    return result


def _scan_plain_gzip_bytes(
    path: str,
    data: bytes,
    config: ScanConfig,
    *,
    budget: ArchiveBudget | None = None,
) -> FileResult:
    """Scan a bounded, valid non-TAR gzip payload from an extensionless cache blob."""
    result = FileResult(archives_scanned=1)
    if budget is None:
        budget = _archive_budget(config)
    compressed_stream = io.BytesIO(data)
    decompressed_stream = gzip.GzipFile(fileobj=compressed_stream, mode="rb")
    limited = _LimitedReader(
        decompressed_stream,
        min(config.max_archive_total_bytes, budget.remaining_bytes),
    )
    chunks: list[bytes] = []
    try:
        while True:
            chunk = limited.read(MIB)
            if not chunk:
                break
            chunks.append(chunk)
    except ArchiveExpansionLimit as exc:
        _result_add_issues(result, [ScanIssue(path, "archive-expansion-limit", str(exc))])
        return result
    except (OSError, EOFError) as exc:
        _result_add_issues(result, [ScanIssue(path, "archive-read", f"{exc.__class__.__name__}: {exc}")])
        return result
    finally:
        decompressed_stream.close()
        compressed_stream.close()
    payload = b"".join(chunks)
    if len(data) and len(payload) > len(data) * config.max_archive_ratio:
        _result_add_issues(result, [
            ScanIssue(path, "archive-expansion-limit", "gzip expansion ratio exceeds configured limit")
        ])
        return result
    if budget.remaining_members <= 0 or len(payload) > budget.remaining_bytes:
        _result_add_issues(
            result,
            [ScanIssue(path, "archive-total-limit", "nested gzip budget exhausted")],
        )
        return result
    budget.remaining_members -= 1
    budget.remaining_bytes -= len(payload)
    virtual_path = f"{path}!<gzip-payload>"
    analysis = analyze_bytes(
        virtual_path,
        payload,
        include_lifecycle_inventory=config.include_lifecycle_inventory,
    )
    _result_add_findings(result, analysis.findings)
    result.lifecycle_scripts += analysis.lifecycle_scripts
    result.archive_members_scanned = 1
    result.bytes_scanned = len(payload)
    return result


def _zip_preflight(data: bytes, config: ScanConfig) -> ScanIssue | None:
    signature = b"PK\x05\x06"
    search_start = max(0, len(data) - (65_535 + 22))
    position = data.rfind(signature, search_start)
    while position >= 0:
        if position + 22 <= len(data):
            try:
                (
                    _signature,
                    disk_number,
                    directory_disk,
                    entries_on_disk,
                    total_entries,
                    directory_size,
                    directory_offset,
                    comment_size,
                ) = struct.unpack_from("<4s4H2LH", data, position)
            except struct.error:
                pass
            else:
                if position + 22 + comment_size == len(data):
                    if disk_number or directory_disk or entries_on_disk != total_entries:
                        return ScanIssue("<zip>", "archive-multidisk", "multi-disk ZIP archives are unsupported")
                    if total_entries == 0xFFFF or directory_size == 0xFFFFFFFF or directory_offset == 0xFFFFFFFF:
                        return ScanIssue("<zip>", "archive-zip64", "ZIP64 requires explicit offline review")
                    if total_entries > config.max_archive_members:
                        return ScanIssue(
                            "<zip>",
                            "archive-limit",
                            f"member count {total_entries} exceeds limit {config.max_archive_members}",
                        )
                    if directory_size > len(data) or directory_offset + directory_size > position:
                        return ScanIssue("<zip>", "archive-open", "central directory bounds are invalid")
                    return None
        position = data.rfind(signature, search_start, position)
    return ScanIssue("<zip>", "archive-open", "end-of-central-directory record is missing or truncated")


def _scan_zip_bytes(
    path: str,
    data: bytes,
    config: ScanConfig,
    *,
    depth: int = 0,
    budget: ArchiveBudget | None = None,
) -> FileResult:
    result = FileResult()
    if budget is None:
        budget = _archive_budget(config)
    preflight = _zip_preflight(data, config)
    if preflight is not None:
        _result_add_issues(result, [dataclasses.replace(preflight, path=path)])
        return result
    try:
        archive = zipfile.ZipFile(io.BytesIO(data), mode="r", allowZip64=False)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, RuntimeError) as exc:
        _result_add_issues(result, [ScanIssue(path, "archive-open", f"{exc.__class__.__name__}: {exc}")])
        return result
    result.archives_scanned = 1
    total_unpacked = 0
    try:
        members = archive.infolist()
        if len(members) > config.max_archive_members:
            _result_add_issues(
                result,
                [ScanIssue(path, "archive-limit", f"member count exceeds limit {config.max_archive_members}")],
            )
            return result
        for member in members:
            virtual_path = f"{path}!{member.filename}"
            if _unsafe_archive_member_name(member.filename):
                _result_add_findings(
                    result,
                    [
                        Finding(
                            virtual_path,
                            "archive-path-traversal",
                            "high",
                            "archive member name escapes its logical root",
                        )
                    ],
                )
            if member.is_dir():
                continue
            unix_mode = (member.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(unix_mode)
            if file_type not in {0, stat.S_IFREG}:
                _result_add_issues(
                    result,
                    [ScanIssue(virtual_path, "archive-link-member", "ZIP link or special member was not opened")],
                )
                continue
            if member.flag_bits & (0x1 | 0x40):
                _result_add_issues(
                    result,
                    [ScanIssue(virtual_path, "archive-encrypted-member", "encrypted ZIP member was not opened")],
                )
                continue
            if member.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                _result_add_issues(
                    result,
                    [ScanIssue(virtual_path, "archive-compression", "unsupported ZIP compression method")],
                )
                continue
            if member.file_size > config.max_archive_member_bytes:
                _result_add_issues(
                    result,
                    [
                        ScanIssue(
                            virtual_path,
                            "archive-member-limit",
                            f"{member.file_size} bytes exceeds limit {config.max_archive_member_bytes}",
                        )
                    ],
                )
                continue
            if member.file_size > max(1, member.compress_size) * config.max_archive_ratio:
                _result_add_issues(
                    result,
                    [ScanIssue(virtual_path, "archive-expansion-limit", "ZIP member expansion ratio exceeds limit")],
                )
                continue
            if budget.remaining_members <= 0:
                _result_add_issues(
                    result,
                    [ScanIssue(path, "archive-limit", "nested archive member budget exhausted")],
                )
                break
            if member.file_size > budget.remaining_bytes:
                _result_add_issues(
                    result,
                    [ScanIssue(path, "archive-total-limit", "nested archive byte budget exhausted")],
                )
                break
            total_unpacked += member.file_size
            if total_unpacked > config.max_archive_total_bytes or (
                len(data) and total_unpacked > len(data) * config.max_archive_ratio
            ):
                _result_add_issues(
                    result,
                    [ScanIssue(path, "archive-total-limit", "ZIP expanded bytes exceed configured limit")],
                )
                break
            budget.remaining_members -= 1
            budget.remaining_bytes -= member.file_size
            chunks: list[bytes] = []
            actual_size = 0
            try:
                with archive.open(member, mode="r") as extracted:
                    while True:
                        chunk = extracted.read(min(MIB, config.max_archive_member_bytes + 1 - actual_size))
                        if not chunk:
                            break
                        chunks.append(chunk)
                        actual_size += len(chunk)
                        if actual_size > config.max_archive_member_bytes:
                            raise ArchiveExpansionLimit("ZIP member grew beyond configured limit")
            except ArchiveExpansionLimit as exc:
                _result_add_issues(result, [ScanIssue(virtual_path, "archive-expansion-limit", str(exc))])
                continue
            except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError, EOFError) as exc:
                _result_add_issues(
                    result,
                    [ScanIssue(virtual_path, "archive-read", f"{exc.__class__.__name__}: {exc}")],
                )
                continue
            member_data = b"".join(chunks)
            if len(member_data) != member.file_size:
                _result_add_issues(
                    result,
                    [ScanIssue(virtual_path, "archive-read", "member size changed or was truncated")],
                )
                continue
            analysis = analyze_bytes(
                virtual_path,
                member_data,
                include_lifecycle_inventory=config.include_lifecycle_inventory,
            )
            _result_add_findings(result, analysis.findings)
            result.lifecycle_scripts += analysis.lifecycle_scripts
            result.archive_members_scanned += 1
            result.bytes_scanned += len(member_data)
            if _is_archive_path(virtual_path, member_data):
                _merge_archive_result(
                    result,
                    _scan_archive_bytes(
                        virtual_path,
                        member_data,
                        config,
                        depth=depth + 1,
                        budget=budget,
                    ),
                )
    finally:
        archive.close()
    return result


def _scan_archive_bytes(
    path: str,
    data: bytes,
    config: ScanConfig,
    *,
    depth: int = 0,
    budget: ArchiveBudget | None = None,
) -> FileResult:
    if budget is None:
        budget = _archive_budget(config)
    if depth > config.max_archive_depth:
        result = FileResult()
        _result_add_issues(
            result,
            [ScanIssue(path, "archive-depth-limit", f"nested archive depth exceeds {config.max_archive_depth}")],
        )
        return result
    if path.lower().endswith(ZIP_ARCHIVE_SUFFIXES) or data.startswith(ZIP_MAGICS):
        return _scan_zip_bytes(path, data, config, depth=depth, budget=budget)
    return _scan_tar_bytes(path, data, config, depth=depth, budget=budget)


def _npm_cache_integrity_finding(path: Path, data: bytes) -> Finding | None:
    parts = path.parts
    try:
        marker = parts.index("content-v2")
        algorithm = parts[marker + 1]
        digest_parts = parts[marker + 2 : marker + 5]
    except (ValueError, IndexError):
        return None
    if len(digest_parts) != 3 or algorithm not in {"sha512", "sha256", "sha1"}:
        return None
    expected = "".join(digest_parts).lower()
    if not re.fullmatch(r"[0-9a-f]+", expected):
        return None
    actual = hashlib.new(algorithm, data).hexdigest()
    if actual == expected:
        return None
    return Finding(
        str(path),
        "npm-cache-integrity-mismatch",
        "critical",
        f"{algorithm} content digest does not match the cacache path",
        sha256=hashlib.sha256(data).hexdigest(),
    )


def _scan_file(open_file: OpenFile, config: ScanConfig, archive_semaphore: threading.Semaphore) -> FileResult:
    result = FileResult()
    path = open_file.path
    data, issue = _safe_read_open_file(open_file, config.max_file_bytes)
    if issue:
        _result_add_issues(result, [issue])
        return result
    assert data is not None
    cache_finding = _npm_cache_integrity_finding(path, data)
    if cache_finding:
        _result_add_findings(result, [cache_finding])
    analysis = analyze_bytes(
        str(path),
        data,
        include_lifecycle_inventory=config.include_lifecycle_inventory,
    )
    _result_add_findings(result, analysis.findings)
    result.lifecycle_scripts += analysis.lifecycle_scripts
    result.files_scanned = 1
    result.bytes_scanned = len(data)
    if config.scan_archives and _is_archive_path(str(path), data):
        with archive_semaphore:
            archive_result = _scan_archive_bytes(str(path), data, config)
        _result_add_findings(result, archive_result.findings)
        _result_add_issues(result, archive_result.issues)
        result.findings_omitted += archive_result.findings_omitted
        result.issues_omitted += archive_result.issues_omitted
        result.bytes_scanned += archive_result.bytes_scanned
        result.archives_scanned += archive_result.archives_scanned
        result.archive_members_scanned += archive_result.archive_members_scanned
        result.lifecycle_scripts += archive_result.lifecycle_scripts
    return result


def _candidate_file(path: Path) -> bool:
    if _is_code_path(str(path)):
        return True
    parts = set(path.parts)
    if "content-v2" in parts or "node_modules" in parts:
        # Packages commonly ship extensionless executables. Obvious media and
        # font payloads are skipped; exact package archives remain candidates.
        return path.suffix.lower() not in {
            ".avi",
            ".bmp",
            ".eot",
            ".gif",
            ".icns",
            ".ico",
            ".jpeg",
            ".jpg",
            ".mov",
            ".mp3",
            ".mp4",
            ".otf",
            ".pdf",
            ".png",
            ".ttf",
            ".webp",
            ".woff",
            ".woff2",
        }
    return False


def _candidate_role(path: Path) -> str:
    """Preserve filename-dependent analysis when deduplicating hardlinks."""
    normalized = str(path).replace("\\", "/")
    name = path.name
    if "content-v2" in path.parts:
        return f"npm-cache:{normalized}"
    if normalized.endswith("/.node_modules/package.json"):
        return "hidden-home-package-manifest"
    if name == "package.json":
        return "package-manifest"
    if name in {"package-lock.json", "npm-shrinkwrap.json"}:
        return "npm-lockfile"
    if normalized.endswith("/.vscode/tasks.json"):
        return "vscode-tasks"
    if normalized.lower().endswith(ARCHIVE_SUFFIXES):
        return "declared-archive"
    if _requires_source_heuristics(normalized):
        return "generic-source-heuristics"
    return "generic-exact-only"


def _default_developer_roots(home: Path) -> list[Path]:
    patterns = [
        str(home / "workspace"),
        str(home / ".npm"),
        str(home / ".node_modules"),
        str(home / ".node_module" / "node_modules"),
        str(home / ".npm-packages" / "lib" / "node_modules"),
        str(home / ".nvm" / "versions" / "node" / "*" / "lib" / "node_modules"),
        str(home / ".volta" / "tools" / "image" / "node" / "*" / "lib" / "node_modules"),
        str(home / ".volta" / "tools" / "image" / "packages" / "*" / "lib" / "node_modules"),
        str(home / ".asdf" / "installs" / "nodejs" / "*" / "lib" / "node_modules"),
        str(home / ".local" / "share" / "mise" / "installs" / "node" / "*" / "lib" / "node_modules"),
        str(home / ".local" / "share" / "fnm" / "node-versions" / "*" / "installation" / "lib" / "node_modules"),
        str(home / ".local" / "share" / "pnpm"),
        str(home / ".pnpm-store"),
        str(home / "Library" / "pnpm"),
        str(home / ".cache" / "node" / "corepack"),
        str(home / ".cache" / "yarn"),
        str(home / "Library" / "Caches" / "Yarn"),
        str(home / ".yarn" / "cache"),
        str(home / ".yarn" / "berry" / "cache"),
        str(home / ".config" / "yarn" / "global" / "node_modules"),
        str(home / ".bun" / "install" / "global" / "node_modules"),
        str(home / ".bun" / "install" / "cache"),
        str(home / ".vscode" / "extensions"),
        str(home / ".cursor" / "extensions"),
        str(home / ".windsurf" / "extensions"),
        str(home / "Library" / "Application Support" / "Code" / "CachedExtensionVSIXs"),
        str(home / "Library" / "Application Support" / "Cursor" / "CachedExtensionVSIXs"),
        str(home / "Library" / "Application Support" / "Windsurf" / "CachedExtensionVSIXs"),
        "/opt/homebrew/lib/node_modules",
        "/usr/local/lib/node_modules",
        "/opt/homebrew/Cellar/node*/**/lib/node_modules",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked",
    ]
    roots: list[Path] = []
    for pattern in patterns:
        for match in glob.glob(pattern, recursive=True):
            candidate = Path(match).expanduser()
            if candidate.exists() or candidate.is_symlink():
                roots.append(candidate)
    return roots


def discover_roots(profile: str, explicit_roots: Sequence[Path], *, no_defaults: bool = False) -> list[Path]:
    home = Path.home().resolve()
    roots: list[Path] = [] if no_defaults else _default_developer_roots(home)
    if not no_defaults and profile == "home":
        roots.insert(0, home)
    elif not no_defaults and profile == "full":
        roots = [
            Path("/Users"),
            Path("/usr/local"),
            Path("/opt/homebrew"),
            Path("/Library/LaunchAgents"),
            Path("/Library/LaunchDaemons"),
            Path("/private/tmp"),
        ] + roots
    roots.extend(path.expanduser() for path in explicit_roots)

    unique: list[Path] = []
    seen: set[bytes] = set()
    for root in roots:
        absolute = Path(os.path.abspath(os.fspath(root)))
        key = os.fsencode(absolute)
        if key not in seen:
            unique.append(absolute)
            seen.add(key)
    return unique


class LocalScanner:
    def __init__(
        self,
        config: ScanConfig,
        *,
        include_quarantine: bool,
        excluded_paths: Sequence[Path],
        jobs: int,
        progress_every: int,
    ) -> None:
        self.config = config
        self.include_quarantine = include_quarantine
        self.excluded_paths = [path.expanduser().resolve(strict=False) for path in excluded_paths]
        self.jobs = max(1, min(16, jobs))
        self.progress_every = max(0, progress_every)
        self.findings: list[Finding] = []
        self.issues: list[ScanIssue] = []
        self.exclusions: set[str] = set()
        self.repositories: set[Path] = set()
        self.stats = ScanStats()
        self._seen_inodes: set[tuple[int, int, str]] = set()
        self._finding_samples_by_severity = {severity: 0 for severity in SEVERITY_RANK}
        self._issues_observed = False
        self._quarantine = (Path.home() / ".quarantine").resolve(strict=False)
        self._archive_semaphore = threading.Semaphore(2)

    @property
    def has_issues(self) -> bool:
        return self._issues_observed

    def _add_findings(self, findings: Iterable[Finding]) -> None:
        for finding in findings:
            severity = finding.severity
            if self._finding_samples_by_severity[severity] < GLOBAL_FINDING_LIMITS[severity]:
                self.findings.append(finding)
                self._finding_samples_by_severity[severity] += 1
            else:
                self.stats.findings_omitted += 1

    def _add_issues(self, issues: Iterable[ScanIssue]) -> None:
        for issue in issues:
            self._issues_observed = True
            if len(self.issues) < GLOBAL_ISSUE_LIMIT:
                self.issues.append(issue)
            else:
                self.stats.issues_omitted += 1

    def _excluded(self, path: Path) -> bool:
        if not self.include_quarantine and _path_is_within(path, self._quarantine):
            self.exclusions.add(str(self._quarantine))
            return True
        for excluded in self.excluded_paths:
            if _path_is_within(path, excluded):
                self.exclusions.add(str(excluded))
                return True
        return False

    def _walk(self, root: Path) -> Iterator[OpenFile]:
        if self._excluded(root):
            return
        try:
            root_stat = root.lstat()
        except OSError as exc:
            self._add_issues([ScanIssue(str(root), "stat-root", f"{exc.__class__.__name__}: {exc}")])
            return
        if stat.S_ISREG(root_stat.st_mode):
            self.stats.files_seen += 1
            if not _candidate_file(root):
                self.stats.non_code_skipped += 1
                return
            inode = (root_stat.st_dev, root_stat.st_ino, _candidate_role(root))
            if inode in self._seen_inodes:
                self.stats.duplicate_inodes_skipped += 1
                return
            flags = (
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_NONBLOCK", 0)
            )
            try:
                descriptor = os.open(root, flags)
                opened = os.fstat(descriptor)
            except OSError as exc:
                self._add_issues([ScanIssue(str(root), "open", f"{exc.__class__.__name__}: {exc}")])
                return
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != inode[:2]:
                os.close(descriptor)
                self._add_issues([ScanIssue(str(root), "race-check", "root changed before open completed")])
                return
            self._seen_inodes.add(inode)
            yield OpenFile(root, descriptor, opened)
            return
        if stat.S_ISLNK(root_stat.st_mode):
            self.stats.symlinks_not_followed += 1
            self._add_issues([ScanIssue(str(root), "root-symlink", "explicit scan root was not followed")])
            return
        if not stat.S_ISDIR(root_stat.st_mode):
            self.stats.special_files_skipped += 1
            return

        directory_flags = (
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_DIRECTORY", 0)
        )
        file_flags = (
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0)
        )

        def frame_for(
            path: Path,
            expected: os.stat_result,
            *,
            parent_descriptor: int | None = None,
            name: str | None = None,
        ) -> DirectoryFrame | None:
            try:
                if parent_descriptor is None:
                    descriptor = os.open(path, directory_flags)
                else:
                    assert name is not None
                    descriptor = os.open(name, directory_flags, dir_fd=parent_descriptor)
                opened = os.fstat(descriptor)
            except OSError as exc:
                self._add_issues([ScanIssue(str(path), "open-directory", f"{exc.__class__.__name__}: {exc}")])
                return None
            if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
                expected.st_dev,
                expected.st_ino,
            ):
                os.close(descriptor)
                self._add_issues([ScanIssue(str(path), "race-check", "directory changed before open completed")])
                return None
            try:
                names = sorted(os.listdir(descriptor), key=os.fsencode)
            except OSError as exc:
                os.close(descriptor)
                self._add_issues([ScanIssue(str(path), "list-directory", f"{exc.__class__.__name__}: {exc}")])
                return None
            return DirectoryFrame(path, descriptor, names)

        def prepare_bare_repository_frame(frame: DirectoryFrame) -> None:
            names = set(frame.names)
            if not {"HEAD", "objects"}.issubset(names) or not names.intersection(
                {"config", "refs", "packed-refs"}
            ):
                return

            def mode_for(name: str) -> int | None:
                try:
                    return os.stat(name, dir_fd=frame.descriptor, follow_symlinks=False).st_mode
                except OSError:
                    return None

            head_mode = mode_for("HEAD")
            objects_mode = mode_for("objects")
            extra_modes = [mode_for(name) for name in ("config", "refs", "packed-refs") if name in names]
            if head_mode is None or objects_mode is None:
                return
            if not stat.S_ISREG(head_mode) or not stat.S_ISDIR(objects_mode):
                return
            if not any(mode is not None and (stat.S_ISREG(mode) or stat.S_ISDIR(mode)) for mode in extra_modes):
                return
            self.repositories.add(frame.path)
            self.exclusions.add(str(frame.path / "objects"))
            frame.names = [name for name in frame.names if name == "hooks"]

        root_frame = frame_for(root, root_stat)
        if root_frame is None:
            return
        prepare_bare_repository_frame(root_frame)
        stack = [root_frame]
        try:
            while stack:
                frame = stack[-1]
                if frame.index >= len(frame.names):
                    os.close(frame.descriptor)
                    stack.pop()
                    continue
                name = frame.names[frame.index]
                frame.index += 1
                path = frame.path / name
                try:
                    entry_stat = os.stat(name, dir_fd=frame.descriptor, follow_symlinks=False)
                except OSError as exc:
                    self._add_issues([ScanIssue(str(path), "stat", f"{exc.__class__.__name__}: {exc}")])
                    continue
                mode = entry_stat.st_mode
                if stat.S_ISLNK(mode):
                    self.stats.symlinks_not_followed += 1
                    continue
                if stat.S_ISDIR(mode):
                    if name == ".git":
                        self.repositories.add(frame.path)
                        self.exclusions.add(str(path / "objects"))
                        git_frame = frame_for(
                            path,
                            entry_stat,
                            parent_descriptor=frame.descriptor,
                            name=name,
                        )
                        if git_frame is None:
                            continue
                        try:
                            hooks_stat = os.stat(
                                "hooks",
                                dir_fd=git_frame.descriptor,
                                follow_symlinks=False,
                            )
                        except FileNotFoundError:
                            os.close(git_frame.descriptor)
                            continue
                        except OSError as exc:
                            self._add_issues([
                                ScanIssue(str(path / "hooks"), "stat", f"{exc.__class__.__name__}: {exc}")
                            ])
                            os.close(git_frame.descriptor)
                            continue
                        if stat.S_ISLNK(hooks_stat.st_mode):
                            self.stats.symlinks_not_followed += 1
                            os.close(git_frame.descriptor)
                            continue
                        if not stat.S_ISDIR(hooks_stat.st_mode):
                            self.stats.special_files_skipped += 1
                            os.close(git_frame.descriptor)
                            continue
                        hooks_frame = frame_for(
                            path / "hooks",
                            hooks_stat,
                            parent_descriptor=git_frame.descriptor,
                            name="hooks",
                        )
                        os.close(git_frame.descriptor)
                        if hooks_frame is not None:
                            stack.append(hooks_frame)
                        continue
                    # A home scan intentionally skips bulk personal/system app
                    # data; package-manager subtrees are separate explicit roots.
                    if frame.path == Path.home().resolve() and name in {
                        "Library",
                        "Movies",
                        "Music",
                        "Pictures",
                        ".Trash",
                    }:
                        self.exclusions.add(str(path))
                        continue
                    if self._excluded(path):
                        continue
                    child_frame = frame_for(
                        path,
                        entry_stat,
                        parent_descriptor=frame.descriptor,
                        name=name,
                    )
                    if child_frame is not None:
                        prepare_bare_repository_frame(child_frame)
                        stack.append(child_frame)
                    continue
                if not stat.S_ISREG(mode):
                    self.stats.special_files_skipped += 1
                    continue
                if name == ".git":
                    self.repositories.add(frame.path)
                self.stats.files_seen += 1
                if not _candidate_file(path):
                    self.stats.non_code_skipped += 1
                    continue
                inode = (entry_stat.st_dev, entry_stat.st_ino, _candidate_role(path))
                if inode in self._seen_inodes:
                    self.stats.duplicate_inodes_skipped += 1
                    continue
                try:
                    descriptor = os.open(name, file_flags, dir_fd=frame.descriptor)
                    opened = os.fstat(descriptor)
                except OSError as exc:
                    self._add_issues([ScanIssue(str(path), "open", f"{exc.__class__.__name__}: {exc}")])
                    continue
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != inode[:2]:
                    os.close(descriptor)
                    self._add_issues([ScanIssue(str(path), "race-check", "file changed before open completed")])
                    continue
                self._seen_inodes.add(inode)
                yield OpenFile(path, descriptor, opened)
        finally:
            for frame in stack:
                try:
                    os.close(frame.descriptor)
                except OSError:
                    pass

    def _consume(self, result: FileResult) -> None:
        self._add_findings(result.findings)
        self._add_issues(result.issues)
        self.stats.findings_omitted += result.findings_omitted
        self.stats.issues_omitted += result.issues_omitted
        if result.issues_omitted:
            self._issues_observed = True
        self.stats.files_scanned += result.files_scanned
        self.stats.bytes_scanned += result.bytes_scanned
        self.stats.archives_scanned += result.archives_scanned
        self.stats.archive_members_scanned += result.archive_members_scanned
        self.stats.lifecycle_scripts += result.lifecycle_scripts
        if self.progress_every and self.stats.files_scanned and self.stats.files_scanned % self.progress_every == 0:
            print(
                f"local-code-scan: progress {self.stats.files_scanned:,} files / "
                f"{self.stats.bytes_scanned / MIB:,.1f} MiB",
                file=sys.stderr,
                flush=True,
            )

    def scan_roots(self, roots: Sequence[Path]) -> None:
        pending: set[concurrent.futures.Future[FileResult]] = set()
        last_heartbeat = time.monotonic()

        def drain(*, all_pending: bool) -> None:
            nonlocal pending, last_heartbeat
            while pending and (all_pending or len(pending) >= self.jobs * 8):
                done, pending = concurrent.futures.wait(
                    pending,
                    timeout=10,
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                if not done:
                    if time.monotonic() - last_heartbeat >= 30:
                        print(
                            f"local-code-scan: heartbeat {self.stats.files_scanned:,} files completed; "
                            f"{len(pending)} worker item(s) active",
                            file=sys.stderr,
                            flush=True,
                        )
                        last_heartbeat = time.monotonic()
                    continue
                for future in done:
                    try:
                        self._consume(future.result())
                    except Exception as exc:  # defensive: preserve incomplete status
                        self._add_issues([ScanIssue("<worker>", "scan", f"{exc.__class__.__name__}: {exc}")])

        with concurrent.futures.ThreadPoolExecutor(max_workers=self.jobs, thread_name_prefix="local-code-scan") as pool:
            for root_index, root in enumerate(roots, start=1):
                print(
                    f"local-code-scan: root {root_index}/{len(roots)} start {json.dumps(str(root))}",
                    file=sys.stderr,
                    flush=True,
                )
                before_files = self.stats.files_scanned
                for open_file in self._walk(root):
                    try:
                        pending.add(pool.submit(_scan_file, open_file, self.config, self._archive_semaphore))
                    except Exception:
                        os.close(open_file.descriptor)
                        raise
                    drain(all_pending=False)
                drain(all_pending=True)
                print(
                    f"local-code-scan: root {root_index}/{len(roots)} complete; "
                    f"{self.stats.files_scanned - before_files:,} file(s)",
                    file=sys.stderr,
                    flush=True,
                )

    def check_host_artifacts(self) -> None:
        staging = Path("/tmp/.npm")
        if staging.exists() or staging.is_symlink():
            self._add_findings([
                Finding(
                    str(staging),
                    "active-stealer-staging",
                    "critical",
                    "incident staging path exists; contents were not opened",
                )
            ])
            self.excluded_paths.append(staging.resolve(strict=False))


def _git_environment() -> dict[str, str]:
    environment = {
        "PATH": "/usr/bin:/bin",
        "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }
    return environment


def _run_git(repo: Path, args: Sequence[str], *, stdin: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [
            "/usr/bin/git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.allow=never",
            "-C",
            str(repo),
            *args,
        ],
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=_git_environment(),
    )


def deduplicate_git_repositories(repositories: Iterable[Path]) -> tuple[list[Path], list[ScanIssue]]:
    """Collapse linked worktrees that share one Git common object database."""
    unique: dict[bytes, Path] = {}
    issues: list[ScanIssue] = []
    for repository in sorted(set(repositories), key=lambda path: os.fsencode(path)):
        result = _run_git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        if result.returncode != 0:
            error = result.stderr.decode("utf-8", "replace").strip()
            issues.append(
                ScanIssue(str(repository), "git-common-dir", error or "cannot resolve shared Git object database")
            )
            key = os.fsencode(repository)
        else:
            rendered = result.stdout.decode("utf-8", "surrogateescape").strip()
            common = Path(rendered)
            if not common.is_absolute():
                common = repository / common
            common = common.resolve(strict=False)
            key = os.fsencode(common)
        unique.setdefault(key, repository)
    return sorted(unique.values(), key=lambda path: os.fsencode(path)), issues


def _git_blob_metadata(repo: Path, mode: str) -> tuple[list[tuple[str, int]], ScanIssue | None]:
    if mode == "all-objects":
        result = _run_git(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"])
    else:
        objects = _run_git(repo, ["rev-list", "--objects", "--no-object-names", "--all"])
        if objects.returncode != 0:
            error = objects.stderr.decode("utf-8", "replace").strip()
            return [], ScanIssue(str(repo), "git-rev-list", error or "git rev-list failed")
        result = _run_git(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], stdin=objects.stdout)
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", "replace").strip()
        return [], ScanIssue(str(repo), "git-object-list", error or "git cat-file failed")
    blobs: dict[str, int] = {}
    try:
        for line in result.stdout.splitlines():
            oid, object_type, raw_size = line.decode("ascii").split()
            if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", oid):
                raise ValueError("invalid object id")
            size = int(raw_size)
            if size < 0:
                raise ValueError("negative object size")
            if object_type == "blob":
                previous = blobs.setdefault(oid, size)
                if previous != size:
                    raise ValueError("duplicate object id has inconsistent sizes")
    except (UnicodeDecodeError, ValueError) as exc:
        return [], ScanIssue(str(repo), "git-object-list", f"malformed output: {exc}")
    return sorted(blobs.items()), None


def _validate_batch_header(header: bytes, expected_oid: str, expected_size: int, max_size: int) -> int:
    if not header.endswith(b"\n") or len(header) > 256:
        raise ValueError("unterminated or oversized batch header")
    fields = header[:-1].split()
    if len(fields) != 3:
        raise ValueError("unexpected batch header field count")
    returned_oid, object_type, raw_size = fields
    if returned_oid != expected_oid.encode("ascii"):
        raise ValueError("batch object id does not match request")
    if object_type != b"blob":
        raise ValueError("batch object type is not blob")
    if not raw_size.isdigit():
        raise ValueError("batch object size is not a non-negative integer")
    returned_size = int(raw_size)
    if returned_size != expected_size:
        raise ValueError("batch object size differs from metadata")
    if returned_size > max_size:
        raise ValueError("batch object size exceeds configured limit")
    return returned_size


def _read_exact(stream: object, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)  # type: ignore[attr-defined]
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def scan_git_repository(repo: Path, mode: str, config: ScanConfig) -> FileResult:
    result = FileResult()
    blobs, issue = _git_blob_metadata(repo, mode)
    if issue:
        _result_add_issues(result, [issue])
        return result

    eligible: list[tuple[str, int]] = []
    for oid, size in blobs:
        virtual_path = f"{repo}@{oid}"
        if oid in KNOWN_MALICIOUS_GIT_OIDS:
            _result_add_findings(
                result,
                [
                    Finding(
                        virtual_path,
                        "known-malicious-git-object",
                        "critical",
                        "Git object matches a verified incident blob",
                        git_oid=oid,
                    )
                ],
            )
        if size > config.max_file_bytes:
            _result_add_issues(
                result,
                [ScanIssue(virtual_path, "git-blob-size-limit", f"{size} bytes exceeds limit {config.max_file_bytes}")],
            )
        else:
            eligible.append((oid, size))
    if not eligible:
        return result

    command = [
        "/usr/bin/git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        "-C",
        str(repo),
        "cat-file",
        "--batch",
    ]
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=_git_environment(),
        )
    except OSError as exc:
        _result_add_issues(result, [ScanIssue(str(repo), "git-cat-file", f"{exc.__class__.__name__}: {exc}")])
        return result
    assert process.stdin is not None and process.stdout is not None
    protocol_error = False
    try:
        for oid, size in eligible:
            virtual_path = f"{repo}@{oid}"
            process.stdin.write(oid.encode("ascii") + b"\n")
            process.stdin.flush()
            header = process.stdout.readline(257)
            try:
                returned_size = _validate_batch_header(header, oid, size, config.max_file_bytes)
            except ValueError as exc:
                _result_add_issues(result, [ScanIssue(virtual_path, "git-cat-file", str(exc))])
                protocol_error = True
                break
            data = _read_exact(process.stdout, returned_size)
            terminator = process.stdout.read(1)
            if len(data) != returned_size or terminator != b"\n":
                _result_add_issues(result, [ScanIssue(virtual_path, "git-cat-file", "truncated batch response")])
                protocol_error = True
                break
            analysis = analyze_bytes(
                virtual_path,
                data,
                include_lifecycle_inventory=config.include_lifecycle_inventory,
                git_oid=oid,
            )
            _result_add_findings(result, analysis.findings)
            result.lifecycle_scripts += analysis.lifecycle_scripts
            result.files_scanned += 1
            result.bytes_scanned += len(data)
        if protocol_error:
            process.kill()
        else:
            process.stdin.close()
        return_code = process.wait(timeout=30)
        if return_code != 0 and not protocol_error:
            _result_add_issues(result, [ScanIssue(str(repo), "git-cat-file", f"exit {return_code}")])
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        process.kill()
        _result_add_issues(result, [ScanIssue(str(repo), "git-cat-file", f"{exc.__class__.__name__}: {exc}")])
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        for stream in (process.stdin, process.stdout):
            if stream is not None and not stream.closed:
                stream.close()
    return result


def _scanner_sha256() -> str:
    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        return "unavailable"


def _report(
    scanner: LocalScanner,
    roots: Sequence[Path],
    args: argparse.Namespace,
    started_at: dt.datetime,
    elapsed: float,
) -> dict[str, object]:
    unique_findings: dict[tuple[object, ...], Finding] = {}
    for finding in scanner.findings:
        key = (
            finding.path,
            finding.rule_id,
            finding.severity,
            finding.offset,
            finding.sha256,
            finding.git_oid,
        )
        unique_findings[key] = finding
    findings = sorted(unique_findings.values(), key=Finding.sort_key)
    counts = {severity: sum(f.severity == severity for f in findings) for severity in SEVERITY_RANK}
    return {
        "schema_version": "1.0",
        "scanner": {
            "name": "local-code-scan",
            "version": SCANNER_VERSION,
            "sha256": _scanner_sha256(),
        },
        "started_at": started_at.astimezone(dt.timezone.utc).isoformat(),
        "elapsed_seconds": round(elapsed, 3),
        "policy": {
            "profile": args.profile,
            "git_history": args.git_history,
            "fail_on": args.fail_on,
            "follow_symlinks": False,
            "archives": not args.no_archives,
            "max_file_bytes": args.max_file_mib * MIB,
            "max_archive_member_bytes": args.max_archive_member_mib * MIB,
            "max_archive_total_bytes": args.max_archive_total_mib * MIB,
            "max_archive_ratio": args.max_archive_ratio,
            "max_archive_depth": args.max_archive_depth,
            "include_quarantine": args.include_quarantine,
            "include_lifecycle_inventory": args.inventory_lifecycle,
        },
        "roots": [str(root) for root in roots],
        "exclusions": sorted(scanner.exclusions, key=os.fsencode),
        "summary": {
            **dataclasses.asdict(scanner.stats),
            "findings": len(findings),
            "findings_reported": len(findings),
            "findings_by_severity": counts,
            "errors": len(scanner.issues) + scanner.stats.issues_omitted,
            "errors_reported": len(scanner.issues),
        },
        "findings": [finding.as_dict() for finding in findings],
        "errors": [issue.as_dict() for issue in sorted(scanner.issues, key=lambda item: (os.fsencode(item.path), item.operation))],
    }


def _human_report(report: Mapping[str, object]) -> str:
    lines: list[str] = []
    for item in report["findings"]:  # type: ignore[index]
        lines.append(Finding(**item).render())  # type: ignore[arg-type]
    for item in report["errors"]:  # type: ignore[index]
        lines.append(ScanIssue(**item).render())  # type: ignore[arg-type]
    summary = report["summary"]  # type: ignore[index]
    lines.append(
        "local-code-scan: "
        f"{summary['files_scanned']:,} files + {summary['git_blobs_scanned']:,} Git blobs; "
        f"{summary['bytes_scanned'] / MIB:,.1f} MiB; "
        f"findings critical={summary['findings_by_severity']['critical']}, "
        f"high={summary['findings_by_severity']['high']}, review={summary['findings_by_severity']['review']}; "
        f"incomplete={summary['errors']}"
    )
    exclusions = report["exclusions"]
    if exclusions:
        lines.append(f"local-code-scan: {len(exclusions)} explicit exclusion(s) recorded in report")
    return "\n".join(lines) + "\n"


def _write_report(path: Path, content: str) -> None:
    path = path.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        payload = memoryview(content.encode("utf-8"))
        while payload:
            written = os.write(descriptor, payload)
            if written <= 0:
                raise OSError("short write while saving report")
            payload = payload[written:]
    finally:
        os.close(descriptor)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("developer", "home", "full"), default="developer")
    parser.add_argument("--root", action="append", type=Path, default=[], help="additional root; repeatable")
    parser.add_argument("--no-default-roots", action="store_true", help="scan only explicit --root values")
    parser.add_argument(
        "--git-history",
        choices=("none", "reachable", "all-objects"),
        default="none",
        help="optionally scan Git blobs; all-objects includes unreachable local objects",
    )
    parser.add_argument("--format", choices=("human", "json"), default="human")
    parser.add_argument("--output", type=Path, help="write the report with mode 0600")
    parser.add_argument("--fail-on", choices=("review", "high", "critical"), default="high")
    parser.add_argument("--exclude", action="append", type=Path, default=[], help="exclude a subtree; repeatable")
    parser.add_argument("--include-quarantine", action="store_true")
    parser.add_argument("--inventory-lifecycle", action="store_true", help="report every npm lifecycle script")
    parser.add_argument("--no-archives", action="store_true", help="do not inspect tar/tgz members")
    parser.add_argument("--max-file-mib", type=int, default=128)
    parser.add_argument("--max-archive-member-mib", type=int, default=32)
    parser.add_argument("--max-archive-total-mib", type=int, default=256)
    parser.add_argument("--max-archive-ratio", type=int, default=200)
    parser.add_argument("--max-archive-depth", type=int, default=2)
    parser.add_argument("--git-only", action="store_true", help="discover repositories and scan Git objects only")
    parser.add_argument("--jobs", type=int, default=min(8, max(2, os.cpu_count() or 2)))
    parser.add_argument("--progress-every", type=int, default=10_000)
    args = parser.parse_args(argv)
    if args.max_file_mib <= 0:
        parser.error("--max-file-mib must be positive")
    if args.max_archive_member_mib <= 0 or args.max_archive_total_mib <= 0:
        parser.error("archive MiB limits must be positive")
    if args.max_archive_member_mib > args.max_archive_total_mib:
        parser.error("--max-archive-member-mib cannot exceed --max-archive-total-mib")
    if args.max_archive_ratio <= 0:
        parser.error("--max-archive-ratio must be positive")
    if args.max_archive_depth < 0 or args.max_archive_depth > 8:
        parser.error("--max-archive-depth must be between 0 and 8")
    if args.jobs <= 0 or args.jobs > 16:
        parser.error("--jobs must be between 1 and 16")
    if args.no_default_roots and not args.root:
        parser.error("--no-default-roots requires at least one --root")
    if args.git_only and args.git_history == "none":
        parser.error("--git-only requires --git-history reachable or all-objects")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    roots = discover_roots(args.profile, args.root, no_defaults=args.no_default_roots)
    if not roots:
        print("local-code-scan: ERROR: no existing scan roots were discovered", file=sys.stderr)
        return 2
    config = ScanConfig(
        max_file_bytes=args.max_file_mib * MIB,
        max_archive_member_bytes=args.max_archive_member_mib * MIB,
        max_archive_total_bytes=args.max_archive_total_mib * MIB,
        max_archive_ratio=args.max_archive_ratio,
        max_archive_depth=args.max_archive_depth,
        include_lifecycle_inventory=args.inventory_lifecycle,
        scan_archives=not args.no_archives,
    )
    scanner = LocalScanner(
        config,
        include_quarantine=args.include_quarantine,
        excluded_paths=args.exclude,
        jobs=args.jobs,
        progress_every=args.progress_every,
    )
    started_at = dt.datetime.now().astimezone()
    started_monotonic = time.monotonic()
    try:
        if args.git_only:
            for root_index, root in enumerate(roots, start=1):
                print(
                    f"local-code-scan: repository discovery {root_index}/{len(roots)} {json.dumps(str(root))}",
                    file=sys.stderr,
                    flush=True,
                )
                for candidate in scanner._walk(root):
                    os.close(candidate.descriptor)
        else:
            scanner.check_host_artifacts()
            scanner.scan_roots(roots)
        if args.git_history != "none":
            scanner.stats.git_repository_paths_discovered = len(scanner.repositories)
            repositories, common_dir_issues = deduplicate_git_repositories(scanner.repositories)
            scanner._add_issues(common_dir_issues)
            scanner.stats.git_repositories = len(repositories)
            print(
                f"local-code-scan: {len(scanner.repositories)} repository path(s), "
                f"{len(repositories)} unique Git object database(s)",
                file=sys.stderr,
                flush=True,
            )
            for index, repository in enumerate(repositories, start=1):
                print(
                    f"local-code-scan: Git {index}/{len(repositories)} {json.dumps(str(repository))}",
                    file=sys.stderr,
                    flush=True,
                )
                git_result = scan_git_repository(repository, args.git_history, config)
                scanner._add_findings(git_result.findings)
                scanner._add_issues(git_result.issues)
                scanner.stats.findings_omitted += git_result.findings_omitted
                scanner.stats.issues_omitted += git_result.issues_omitted
                if git_result.issues_omitted:
                    scanner._issues_observed = True
                scanner.stats.git_blobs_scanned += git_result.files_scanned
                scanner.stats.bytes_scanned += git_result.bytes_scanned
                scanner.stats.lifecycle_scripts += git_result.lifecycle_scripts
    except KeyboardInterrupt:
        print("local-code-scan: interrupted", file=sys.stderr)
        return 130

    elapsed = time.monotonic() - started_monotonic
    report = _report(scanner, roots, args, started_at, elapsed)
    content = json.dumps(report, indent=2, ensure_ascii=True, sort_keys=True) + "\n" if args.format == "json" else _human_report(report)
    if args.output:
        try:
            _write_report(args.output, content)
        except OSError as exc:
            print(f"local-code-scan: ERROR writing report: {_terminal_quote(exc)}", file=sys.stderr)
            return 2
        print(f"local-code-scan: report written to {_terminal_quote(args.output.expanduser())}", file=sys.stderr)
    else:
        target = sys.stdout if args.format == "json" else sys.stderr
        print(content, file=target, end="")

    if scanner.has_issues:
        return 2
    threshold = SEVERITY_RANK[args.fail_on]
    return 1 if any(SEVERITY_RANK[finding.severity] >= threshold for finding in scanner.findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
