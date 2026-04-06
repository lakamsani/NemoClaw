#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


WORKSPACE_DIR = Path(__file__).resolve().parent.parent
ARTIFACT_PATH = WORKSPACE_DIR / "session-artifacts.json"

DEFAULT_ARTIFACT = {
    "updated_at": None,
    "repo": None,
    "issue": {
        "number": None,
        "url": None,
        "status": None,
    },
    "branch": {
        "name": None,
    },
    "commit": {
        "sha": None,
    },
    "pull_request": {
        "number": None,
        "url": None,
        "status": None,
    },
}


def deep_copy_default():
    return json.loads(json.dumps(DEFAULT_ARTIFACT))


def load_artifact():
    if not ARTIFACT_PATH.exists():
        return deep_copy_default()
    with ARTIFACT_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    artifact = deep_copy_default()
    merge(artifact, data)
    return artifact


def merge(base, override):
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge(base[key], value)
        else:
            base[key] = value


def save_artifact(artifact):
    artifact["updated_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ARTIFACT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(artifact, handle, indent=2)
        handle.write("\n")


def parse_optional_int(value):
    return None if value in (None, "", "null") else int(value)


def parse_optional_str(value):
    return None if value in (None, "", "null") else value


def cmd_init(_args):
    save_artifact(deep_copy_default())


def cmd_show(args):
    artifact = load_artifact()
    if args.compact:
        print(json.dumps(artifact, separators=(",", ":")))
    else:
        print(json.dumps(artifact, indent=2))


def cmd_set_repo(args):
    artifact = load_artifact()
    artifact["repo"] = args.repo
    save_artifact(artifact)


def cmd_set_issue(args):
    artifact = load_artifact()
    artifact["issue"]["number"] = parse_optional_int(args.number)
    artifact["issue"]["url"] = parse_optional_str(args.url)
    artifact["issue"]["status"] = parse_optional_str(args.status)
    save_artifact(artifact)


def cmd_set_branch(args):
    artifact = load_artifact()
    artifact["branch"]["name"] = parse_optional_str(args.name)
    save_artifact(artifact)


def cmd_set_commit(args):
    artifact = load_artifact()
    artifact["commit"]["sha"] = parse_optional_str(args.sha)
    save_artifact(artifact)


def cmd_set_pr(args):
    artifact = load_artifact()
    artifact["pull_request"]["number"] = parse_optional_int(args.number)
    artifact["pull_request"]["url"] = parse_optional_str(args.url)
    artifact["pull_request"]["status"] = parse_optional_str(args.status)
    save_artifact(artifact)


def build_parser():
    parser = argparse.ArgumentParser(description="Manage workspace session-artifacts.json deterministically.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Reset session-artifacts.json to the default empty structure.")
    init_parser.set_defaults(func=cmd_init)

    show_parser = subparsers.add_parser("show", help="Print the current session-artifacts.json content.")
    show_parser.add_argument("--compact", action="store_true", help="Print compact JSON.")
    show_parser.set_defaults(func=cmd_show)

    repo_parser = subparsers.add_parser("set-repo", help="Set the active GitHub repository.")
    repo_parser.add_argument("repo", help="Repository in owner/repo format.")
    repo_parser.set_defaults(func=cmd_set_repo)

    issue_parser = subparsers.add_parser("set-issue", help="Set issue fields.")
    issue_parser.add_argument("--number", required=True, help="Issue number or 'null'.")
    issue_parser.add_argument("--url", help="Issue URL or 'null'.")
    issue_parser.add_argument("--status", help="Issue status or 'null'.")
    issue_parser.set_defaults(func=cmd_set_issue)

    branch_parser = subparsers.add_parser("set-branch", help="Set the current branch.")
    branch_parser.add_argument("--name", required=True, help="Branch name or 'null'.")
    branch_parser.set_defaults(func=cmd_set_branch)

    commit_parser = subparsers.add_parser("set-commit", help="Set the latest pushed commit SHA.")
    commit_parser.add_argument("--sha", required=True, help="Commit SHA or 'null'.")
    commit_parser.set_defaults(func=cmd_set_commit)

    pr_parser = subparsers.add_parser("set-pr", help="Set pull request fields.")
    pr_parser.add_argument("--number", required=True, help="PR number or 'null'.")
    pr_parser.add_argument("--url", help="PR URL or 'null'.")
    pr_parser.add_argument("--status", help="PR status or 'null'.")
    pr_parser.set_defaults(func=cmd_set_pr)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
