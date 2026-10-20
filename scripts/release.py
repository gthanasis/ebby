"""Versions for ebby: what a pull request releases, and the tag it becomes once merged.

Every pull request carries one label saying what it releases:

  release:patch   fixes, copy, small tweaks
  release:minor   new features and additions that need nothing from whoever runs ebby
  release:major   anything an install has to act on, or that the previous version can't run beside
  release:none    nothing a running install would notice (docs, tests, CI)

  python3 scripts/release.py check   in CI, on a pull request: the label is there, and nothing breaking hides
                                     under a smaller one
  python3 scripts/release.py next    after CI passes on main: the version the merged pull request makes

"Breaking" is judged against two pods running side by side during a rolling update: the previous version
keeps serving against the new schema until its pod is replaced, and a rollback runs it again for good.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

LABELS = ("release:patch", "release:minor", "release:major", "release:none")
MIGRATIONS = "app/data/migrations/"
ENV_EXAMPLE = ".env.example"

# Statements the previous version can't run beside: it still reads what these take away or change.
DESTRUCTIVE = [
    (r"\bDROP\s+(TABLE|COLUMN|VIEW|FUNCTION|TYPE|POLICY|INDEX)\b", "drops something"),
    (r"\bRENAME\b", "renames something"),
    (r"\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b", "changes a column's type"),
    (r"\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b", "makes a column required"),
    (r"\bTRUNCATE\b", "empties a table"),
    (r"\bDELETE\s+FROM\b", "deletes rows"),
    (r"\bUPDATE\s+\w+\s+SET\b", "rewrites existing rows"),
]
NOT_BREAKING = re.compile(r"^Not breaking:\s*\S", re.M | re.I)
UPGRADE_NOTES = re.compile(r"^#+\s*Upgrade notes\b", re.M | re.I)


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def env_names(text: str) -> set[str]:
    return set(re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", text, re.M))


def breaking_changes(base: str) -> list[str]:
    """What in this branch, compared with base, the previous version or an existing install would trip on."""
    found = []
    for line in git("diff", "--name-status", f"{base}...HEAD", "--", MIGRATIONS).splitlines():
        status, *paths = line.split("\t")
        path = paths[-1]
        if not status.startswith("A"):
            found.append(f"{path}: an existing migration was changed or removed. Installs that already applied it "
                         "won't run it again; add a new numbered migration instead.")
            continue
        sql = re.sub(r"--[^\n]*", "", Path(path).read_text())
        found += [f"{path}: {why}" for pattern, why in DESTRUCTIVE if re.search(pattern, sql, re.I)]
    before = git("show", f"{base}:{ENV_EXAMPLE}") if git("ls-tree", base, "--", ENV_EXAMPLE) else ""
    after = Path(ENV_EXAMPLE).read_text() if Path(ENV_EXAMPLE).exists() else ""
    if gone := sorted(env_names(before) - env_names(after)):
        found.append(f"{ENV_EXAMPLE}: {', '.join(gone)} no longer listed. Installs that set it would lose it silently.")
    return found


def check() -> int:
    """A pull request: exactly one release label, and a breaking change only under release:major or explained."""
    labels = [l for l in json.loads(os.environ.get("LABELS") or "[]") if l.startswith("release:")]
    body = os.environ.get("BODY") or ""
    problems = []
    if len(labels) != 1 or labels[0] not in LABELS:
        problems.append(f"Label this pull request with exactly one of {', '.join(LABELS)} (now: {labels or 'none'}).")
    label = labels[0] if len(labels) == 1 else None
    found = breaking_changes(os.environ["BASE"])
    if found and label != "release:major" and not NOT_BREAKING.search(body):
        problems.append("This looks like a breaking change:\n" + "\n".join(f"  - {f}" for f in found) +
                        "\nEither label it release:major (with an '## Upgrade notes' section), or say why it isn't on a "
                        "line of its own in the description: 'Not breaking: <why>'.")
    if label == "release:major" and not UPGRADE_NOTES.search(body):
        problems.append("A major release needs an '## Upgrade notes' section: what someone running ebby has to do.")
    for p in problems:
        print(f"::error::{p}" if os.environ.get("GITHUB_ACTIONS") else p)
    if not problems:
        print(f"{label}: ok" + (" (breaking, explained in the description)" if found and label != "release:major" else ""))
    return 1 if problems else 0


def merged_pr(sha: str) -> dict | None:
    out = subprocess.run(["gh", "api", f"repos/{os.environ['GITHUB_REPOSITORY']}/commits/{sha}/pulls"],
                         check=True, capture_output=True, text=True).stdout
    return next((p for p in json.loads(out) if p.get("merged_at")), None)


def bump(version: str, label: str) -> str:
    major, minor, patch = (int(p) for p in version.split("."))
    if label == "release:major":
        return f"{major + 1}.0.0"
    if label == "release:minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def next_version() -> int:
    """Prints GitHub step outputs for the commit just merged: version (empty when nothing to release), pr, label.
    Writes the major release's upgrade notes to release-notes.md."""
    sha = os.environ["SHA"]
    if any(t.startswith("v") for t in git("tag", "--points-at", sha).split()):
        print("version=")  # already released (a re-run)
        return 0
    pr = merged_pr(sha)
    labels = [l["name"] for l in pr["labels"] if l["name"].startswith("release:")] if pr else []
    # A push straight to main, without a pull request, is a patch: a major never happens by accident.
    label = labels[0] if len(labels) == 1 else "release:patch"
    tags = git("tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname").split()
    version = "" if label == "release:none" else bump(tags[0][1:] if tags else "0.0.0", label)
    notes = ""
    if label == "release:major" and pr and (m := UPGRADE_NOTES.search(body := pr.get("body") or "")):
        end = re.search(r"^#{1,2}\s", body[m.end():], re.M)  # up to the next section
        notes = body[m.start():m.end() + end.start() if end else None].strip()
    Path("release-notes.md").write_text(notes + "\n")
    print(f"version={version}\npr={pr['number'] if pr else ''}\nlabel={label}")
    return 0


if __name__ == "__main__":
    sys.exit({"check": check, "next": next_version}[sys.argv[1]]())
