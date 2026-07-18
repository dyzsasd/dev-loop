from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from security.source_integrity import REPO_ROOT, scan_bytes, scan_history


def rules_for(
    path: str,
    data: bytes,
    *,
    source_path: str | None = None,
    expected_test_paths: frozenset[str] | None = None,
) -> set[str]:
    return {
        finding.rule
        for finding in scan_bytes(
            path,
            data,
            source_path=source_path,
            expected_test_paths=expected_test_paths,
        )
    }


def original_injected_shim() -> bytes:
    # Build the fixture independently of the production constant so an
    # accidental detector change makes this regression test fail.
    return (
        b"import { createRequire } from "
        + b"'module';\n"
        + b"const require = create"
        + b"Require(import.meta.url);\n"
    )


def git(repo: Path, *arguments: str, stdin: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *arguments],
        input=stdin,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout


class SourceIntegrityRegressionTest(unittest.TestCase):
    def test_original_padded_eval_loader_is_rejected(self) -> None:
        marker = b"5-3-" + b"339-du"
        dynamic_call = b"ev" + b"al("
        decoder = b"at" + b"ob("
        sample = (
            b"export const clean = true;\n"
            + original_injected_shim()
            + b" " * 2_000
            + dynamic_call
            + b'"global.o=\''
            + marker
            + b"';+"
            + decoder
            + b"'ZGFuZ2Vy')\n"
        )
        rules = rules_for("sample.ts", sample)
        self.assertTrue(
            {"campaign-marker", "injected-require-shim", "dynamic-decoder", "horizontal-padding", "oversized-line"}
            <= rules
        )

    def test_npm_persistence_variant_is_rejected(self) -> None:
        first_marker = b"C260" + b"521A"
        second_marker = b"RS260" + b"605"
        constructor = b"new " + b"Func" + b"tion("
        sample = b"/*" + first_marker + b"*/ /*" + second_marker + b"*/ " + constructor + b"source)"
        rules = rules_for("cli.js", sample)
        self.assertIn("npm-persistence-marker", rules)
        self.assertIn("function-constructor", rules)

    def test_prefix_only_injection_is_rejected(self) -> None:
        self.assertIn("injected-require-shim", rules_for("tool.mjs", original_injected_shim() + b"export {};\n"))

    def test_mutated_loader_still_hits_structural_rules(self) -> None:
        constructor = b"new " + b"Func" + b"tion("
        sample = b"const ok = 1;" + b" " * 256 + constructor + b"downloaded)\n"
        rules = rules_for("mutated.js", sample)
        self.assertIn("horizontal-padding", rules)
        self.assertIn("function-constructor", rules)

    def test_direct_function_constructor_is_rejected(self) -> None:
        constructor = b"Func" + b"tion("
        self.assertIn("function-constructor", rules_for("mutated.js", constructor + b"payload)()"))

    def test_history_path_with_scope_keeps_source_classification(self) -> None:
        constructor = b"new " + b"Func" + b"tion("
        sample = constructor + b"downloaded)\n"
        self.assertIn("function-constructor", rules_for("packages/@scope/tool.ts", sample))
        self.assertIn(
            "function-constructor",
            rules_for("packages/@scope/tool.ts@0123456789ab", sample, source_path="packages/@scope/tool.ts"),
        )

    def test_known_clean_source_limits_have_headroom(self) -> None:
        sample = b"a" * 500 + b" " * 87 + b"z\n"
        self.assertEqual(set(), rules_for("clean.ts", sample))

    def test_generic_rules_ignore_non_executable_binary(self) -> None:
        constructor = b"new " + b"Func" + b"tion("
        sample = b"\x00" + b" " * 512 + constructor + b"x)"
        self.assertEqual(set(), rules_for("fixture.png", sample))

    def test_lockfile_rejects_dependency_hook_and_non_registry_source(self) -> None:
        lockfile = {
            "lockfileVersion": 3,
            "packages": {
                "": {"hasInstallScript": True},
                "node_modules/bad": {
                    "hasInstallScript": True,
                    "resolved": "git+https://example.invalid/bad.git",
                },
            },
        }
        rules = rules_for("package-lock.json", json.dumps(lockfile).encode())
        self.assertIn("dependency-install-script", rules)
        self.assertIn("non-registry-dependency", rules)
        self.assertIn("missing-package-integrity", rules)

    def test_history_is_nul_safe_preserves_aliases_and_scans_old_lockfiles(self) -> None:
        constructor = b"new " + b"Func" + b"tion("
        dangerous_source = constructor + b"downloaded)\n"
        bad_lockfile = {
            "lockfileVersion": 3,
            "packages": {
                "": {},
                "node_modules/bad": {
                    "hasInstallScript": True,
                    "resolved": "git+https://example.invalid/bad.git",
                },
            },
        }

        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            git(repo, "init", "-q")
            git(repo, "config", "user.name", "Integrity Test")
            git(repo, "config", "user.email", "integrity@example.invalid")
            dangerous_oid = git(repo, "hash-object", "-w", "--stdin", stdin=dangerous_source).strip()
            clean_source_oid = git(repo, "hash-object", "-w", "--stdin", stdin=b"export const clean = true;\n").strip()
            clean_fixture_oid = git(repo, "hash-object", "-w", "--stdin", stdin=b"clean fixture\n").strip()
            bad_lock_oid = git(
                repo,
                "hash-object",
                "-w",
                "--stdin",
                stdin=json.dumps(bad_lockfile).encode(),
            ).strip()
            clean_lock_oid = git(
                repo,
                "hash-object",
                "-w",
                "--stdin",
                stdin=b'{"lockfileVersion":3,"packages":{"":{}}}\n',
            ).strip()

            def tree(source_oid: bytes, fixture_oid: bytes, lock_oid: bytes) -> str:
                entries = b"".join(
                    (
                        b"100644 blob " + fixture_oid + b"\tfixture.bin\0",
                        b"100644 blob " + source_oid + b"\todd-\xff\n.ts\0",
                        b"100644 blob " + lock_oid + b"\tpackage-lock.json\0",
                    )
                )
                return git(repo, "mktree", "-z", stdin=entries).strip().decode("ascii")

            bad_tree = tree(dangerous_oid, dangerous_oid, bad_lock_oid)
            bad_commit = git(repo, "commit-tree", bad_tree, "-m", "historical unsafe tree").strip().decode("ascii")
            clean_tree = tree(clean_source_oid, clean_fixture_oid, clean_lock_oid)
            clean_commit = git(
                repo,
                "commit-tree",
                clean_tree,
                "-p",
                bad_commit,
                "-m",
                "clean current tree",
            ).strip().decode("ascii")
            git(repo, "update-ref", "refs/heads/main", clean_commit)
            git(repo, "symbolic-ref", "HEAD", "refs/heads/main")

            findings, _scanned = scan_history(repo)

        rules = {finding.rule for finding in findings}
        self.assertIn("function-constructor", rules)
        self.assertIn("dependency-install-script", rules)
        self.assertTrue(any("\\n.ts@" in finding.path for finding in findings))

    def test_workflows_disable_implicit_lifecycle_hooks(self) -> None:
        for relative_path in (".github/workflows/test.yml", ".github/workflows/release-npm.yml"):
            workflow = (REPO_ROOT / relative_path).read_text(encoding="utf-8")
            self.assertIn('NPM_CONFIG_IGNORE_SCRIPTS: "true"', workflow, relative_path)
        release_workflow = (REPO_ROOT / ".github/workflows/release-npm.yml").read_text(encoding="utf-8")
        self.assertIn("git ls-remote --tags origin", release_workflow)
        self.assertIn("git ls-remote --heads origin", release_workflow)

    def test_release_manifest_rejects_shell_injection_and_implicit_hooks(self) -> None:
        manifest = {
            "scripts": {
                "typecheck": "tsc -p tsconfig.check.json",
                "build": (
                    "rm -rf dist .claude-plugin skills references hooks config && "
                    "tsc -p tsconfig.build.json && chmod +x dist/cli.js dist/server.js && "
                    "cp -R ../.claude-plugin ../skills ../references ../hooks ../config ./"
                ),
                "test": "node test/safe.ts && curl https://example.invalid",
                "pretest": "node surprise.js",
            }
        }
        rules = rules_for(
            "hub/package.json",
            json.dumps(manifest).encode(),
            expected_test_paths=frozenset({"test/safe.ts"}),
        )
        self.assertIn("unsafe-package-script", rules)


if __name__ == "__main__":
    unittest.main()
