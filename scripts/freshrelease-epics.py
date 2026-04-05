#!/usr/bin/env python3

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
from datetime import datetime
from html import unescape

BASE_URL = "https://freshworks.freshrelease.com"
MAX_PROJECT_PAGES = 10


class FreshreleaseError(Exception):
    pass


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def request_json(path, token, params=None, retries=3):
    url = f"{BASE_URL}{path}"
    if params:
        query = urllib.parse.urlencode(params, doseq=True)
        url = f"{url}?{query}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Token {token}",
            "Accept": "application/json",
        },
    )
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace").strip()
            if exc.code in {408, 429, 500, 502, 503, 504} and attempt < retries:
                time.sleep(min(2 ** attempt, 5))
                attempt += 1
                continue
            detail = f"HTTP {exc.code}"
            if body:
                detail = f"{detail}: {body[:200]}"
            raise FreshreleaseError(f"Freshrelease request failed for {path}: {detail}") from exc
        except urllib.error.URLError as exc:
            if attempt < retries:
                time.sleep(min(2 ** attempt, 5))
                attempt += 1
                continue
            reason = getattr(exc, "reason", exc)
            raise FreshreleaseError(f"Freshrelease request failed for {path}: {reason}") from exc
        except TimeoutError as exc:
            if attempt < retries:
                time.sleep(min(2 ** attempt, 5))
                attempt += 1
                continue
            raise FreshreleaseError(f"Freshrelease request timed out for {path}") from exc


def project_candidates(project):
    raw = str(project or "").strip()
    if not raw:
        return []
    upper = raw.upper().replace(" ", "")
    collapsed = re.sub(r"[^A-Za-z0-9]+", "", raw).upper()
    dashed = re.sub(r"[^A-Za-z0-9]+", "-", raw).strip("-").upper()
    candidates = [raw, upper, collapsed, dashed]
    return [candidate for idx, candidate in enumerate(candidates) if candidate and candidate not in candidates[:idx]]


def normalize_project_text(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def iter_projects(token):
    seen = set()
    for page in range(1, MAX_PROJECT_PAGES + 1):
        payload = request_json("/projects", token, params={"page": page, "per_page": 100})
        projects = payload.get("projects", []) or []
        if not projects:
            break
        for project in projects:
            key = str(project.get("key") or "").upper()
            if key and key not in seen:
                seen.add(key)
                yield project


def resolve_project_key(project, token):
    candidates = project_candidates(project)
    for candidate in candidates:
        try:
            request_json(f"/{candidate}/issue_types", token, retries=1)
            return candidate.upper()
        except FreshreleaseError:
            continue

    requested = normalize_project_text(project)
    if not requested:
        raise FreshreleaseError("Project name is empty")

    exact_matches = []
    partial_matches = []
    for item in iter_projects(token):
        haystacks = [
            str(item.get("key") or ""),
            str(item.get("name") or ""),
            str(item.get("title") or ""),
            html_to_text(item.get("description") or ""),
        ]
        normalized_values = [normalize_project_text(value) for value in haystacks if value]
        if requested in normalized_values:
            exact_matches.append(item)
            continue
        if any(requested and requested in value for value in normalized_values):
            partial_matches.append(item)

    matches = exact_matches or partial_matches
    if len(matches) == 1:
        return str(matches[0].get("key") or "").upper()
    if len(matches) > 1:
        options = ", ".join(sorted({str(item.get("key") or "").upper() for item in matches if item.get("key")}))
        raise FreshreleaseError(f"Project '{project}' is ambiguous. Matches: {options}")
    raise FreshreleaseError(f"Project '{project}' was not found in Freshrelease")


def find_epic_type(issue_types):
    matches = [
        item
        for item in issue_types
        if "EPIC" in str(item.get("label", "")).upper() or "EPIC" in str(item.get("name", "")).upper()
    ]
    return matches[0] if matches else None


def normalize_date(value):
    value = value or ""
    if not value:
        return ""
    raw = str(value).split("T", 1)[0]
    try:
        return datetime.strptime(raw, "%Y-%m-%d").strftime("%b %d, %Y")
    except ValueError:
        return raw


def html_to_text(value):
    text = unescape(str(value or ""))
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p\s*>", "\n\n", text, flags=re.I)
    text = re.sub(r"<li\s*>", "- ", text, flags=re.I)
    text = re.sub(r"</li\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def issue_url(project, issue_key):
    return f"{BASE_URL}/{project}/issues/{issue_key}"


def fetch_issue_detail(project, issue_key, token):
    payload = request_json(
        f"/{project}/issues/{issue_key}",
        token,
        params={"include": "owner,reporter,priority,status"},
    )
    issue = payload.get("issue", {})
    users = {u.get("id"): u.get("name") for u in payload.get("users", [])}
    statuses = {s.get("id"): s.get("label") for s in payload.get("statuses", [])}
    current_state = (
        statuses.get(issue.get("status_id"))
        or (issue.get("status") or {}).get("label")
        or issue.get("state_name")
        or issue.get("status_id")
        or ""
    )
    return {
        "id": issue.get("id"),
        "key": issue.get("key"),
        "title": issue.get("title"),
        "url": issue_url(project, issue.get("key") or issue_key),
        "assigned_user": users.get(issue.get("owner_id"), issue.get("owner_id") or ""),
        "current_state": current_state,
        "created_date": normalize_date(issue.get("created_at")),
        "targeted_date": normalize_date(
            issue.get("due_by") or issue.get("predicted_end_date") or issue.get("start_date")
        ),
        "updated": normalize_date(issue.get("updated_at") or issue.get("updated_on")),
        "description": html_to_text(issue.get("description")),
    }


def fetch_issue_comments(project, issue_key, token):
    payload = request_json(f"/{project}/issues/{issue_key}/comments", token)
    comments = []
    for comment in payload.get("comments", []) or []:
        body = html_to_text(
            comment.get("body")
            or comment.get("comment")
            or comment.get("description")
            or comment.get("content")
            or ""
        )
        author = (
            comment.get("user_name")
            or comment.get("author_name")
            or comment.get("name")
            or comment.get("created_by_name")
            or comment.get("updated_by_name")
            or ""
        )
        created = normalize_date(comment.get("created_at") or comment.get("updated_at"))
        comments.append({
            "author": author,
            "created": created,
            "body": body,
        })
    return comments


def project_from_issue_key(issue_key):
    return str(issue_key or "").split("-", 1)[0].upper()


def normalize_state_text(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def fetch_statuses(project, token):
    payload = request_json(f"/{project}/statuses", token)
    return payload.get("statuses", []) or []


def resolve_status_filters(project, token, status_query):
    if not status_query:
        return set()
    normalized_query = normalize_state_text(status_query)
    if not normalized_query:
        return set()
    statuses = fetch_statuses(project, token)
    aliases = {
        "open": {"open"},
        "todo": {"to do", "todo"},
        "to do": {"to do", "todo"},
        "in progress": {"in progress"},
        "done": {"done"},
        "blocked": {"blocked", "blocker"},
        "ready to test": {"ready to test"},
        "in review": {"in review"},
        "backlog": {"backlog"},
    }
    candidates = aliases.get(normalized_query, {normalized_query})
    matches = set()
    for status in statuses:
        label = normalize_state_text(status.get("label"))
        name = normalize_state_text(status.get("name"))
        if label in candidates or name in candidates:
            matches.add(status.get("label") or status.get("name") or "")
            continue
        if any(candidate in label or candidate in name for candidate in candidates):
            matches.add(status.get("label") or status.get("name") or "")
    return {item for item in matches if item}


def issue_matches_status(issue, allowed_statuses):
    if not allowed_statuses:
        return True
    return str(issue.get("current_state") or "") in allowed_statuses


def collect_children(parent_key, token, status_query=None):
    project = project_from_issue_key(parent_key)
    parent = fetch_issue_detail(project, parent_key, token)
    parent_id = parent.get("id")
    if not parent_id:
        fail(f"Could not resolve issue id for {parent_key}")
    allowed_statuses = resolve_status_filters(project, token, status_query)

    payload = request_json(
        f"/{project}/issues",
        token,
        params={
            "include": "owner,reporter,priority,status",
            "per_page": 100,
            "query_hash[0][condition]": "parent_id",
            "query_hash[0][operator]": "is_in",
            "query_hash[0][value][]": [parent_id],
        },
    )
    issues = payload.get("issues", [])
    issues.sort(key=lambda x: x.get("updated_at") or x.get("updated_on") or x.get("created_at") or "", reverse=True)
    children = [fetch_issue_detail(project, issue.get("key"), token) for issue in issues]
    if allowed_statuses:
        children = [issue for issue in children if issue_matches_status(issue, allowed_statuses)]
    return {
        "project": project,
        "parent_key": parent_key,
        "parent_title": parent.get("title"),
        "children": children,
        "status_query": status_query or "",
        "allowed_statuses": sorted(allowed_statuses),
    }


def collect_issue(issue_key, token):
    project = project_from_issue_key(issue_key)
    issue = fetch_issue_detail(project, issue_key, token)
    comments = fetch_issue_comments(project, issue_key, token)
    return {
        "project": project,
        "issue": issue,
        "comments": comments,
    }


def collect_epics(project, token, limit, status_query=None):
    project = resolve_project_key(project, token)
    issue_types = request_json(f"/{project}/issue_types", token).get("issue_types", [])
    epic_type = find_epic_type(issue_types)
    if not epic_type:
        return {
            "project": project,
            "epic_type": None,
            "epics": [],
            "issue_type_candidates": [(x.get("id"), x.get("label"), x.get("name")) for x in issue_types[:20]],
        }
    allowed_statuses = resolve_status_filters(project, token, status_query)

    params = {
        "include": "owner,reporter,priority,status",
        "per_page": 100,
        "query_hash[0][condition]": "issue_type_id",
        "query_hash[0][operator]": "is",
        "query_hash[0][value]": epic_type["id"],
    }
    payload = request_json(f"/{project}/issues", token, params=params)
    issues = payload.get("issues", [])
    issues.sort(key=lambda x: x.get("updated_at") or x.get("updated_on") or x.get("created_at") or "", reverse=True)

    epics = []
    for issue in issues[:limit]:
        epics.append(fetch_issue_detail(project, issue.get("key"), token))
    if allowed_statuses:
        epics = [issue for issue in epics if issue_matches_status(issue, allowed_statuses)]
    return {
        "project": project,
        "epic_type": (epic_type.get("id"), epic_type.get("label"), epic_type.get("name")),
        "epics": epics,
        "issue_type_candidates": [],
        "status_query": status_query or "",
        "allowed_statuses": sorted(allowed_statuses),
    }


def main(argv):
    token = os.environ.get("FRESHRELEASE_API_KEY", "").strip()
    if not token:
        fail("FRESHRELEASE_API_KEY is missing")

    args = argv[1:]
    if args and args[0] == "--children":
        if len(args) < 2:
            fail("Usage: freshrelease-epics.py --children <ISSUE-KEY>")
        result = collect_children(args[1], token, os.environ.get("FR_STATUS_QUERY", "").strip())
        print(f"## {result['parent_key']}")
        print(f"Parent title: {result['parent_title']}")
        if result["allowed_statuses"]:
            print(f"State filter: {', '.join(result['allowed_statuses'])}")
        if not result["children"]:
            print("No child stories found.")
            return
        print("| Key | Title | Assigned User | Current State | Created Date | Targeted Date | Updated | Link |")
        print("|---|---|---|---|---|---|---|---|")
        for issue in result["children"]:
            title = str(issue["title"] or "").replace("|", "/")
            owner = str(issue["assigned_user"] or "").replace("|", "/")
            status = str(issue["current_state"] or "").replace("|", "/")
            created = str(issue["created_date"] or "").replace("|", "/")
            targeted = str(issue["targeted_date"] or "").replace("|", "/")
            updated = str(issue["updated"] or "").replace("|", "/")
            link = f"[{issue['key']}]({issue['url']})" if issue.get("url") else ""
            print(f"| {issue['key']} | {title} | {owner} | {status} | {created} | {targeted} | {updated} | {link} |")
        return

    if args and args[0] == "--issue":
        if len(args) < 2:
            fail("Usage: freshrelease-epics.py --issue <ISSUE-KEY>")
        result = collect_issue(args[1], token)
        issue = result["issue"]
        print(f"## {issue['key']}")
        print("| Field | Value |")
        print("|---|---|")
        print(f"| Project | {result['project']} |")
        print(f"| Key | {issue['key']} |")
        print(f"| Title | {str(issue['title'] or '').replace('|', '/')} |")
        print(f"| Assigned User | {str(issue['assigned_user'] or '').replace('|', '/')} |")
        print(f"| Current State | {str(issue['current_state'] or '').replace('|', '/')} |")
        print(f"| Created Date | {str(issue['created_date'] or '').replace('|', '/')} |")
        print(f"| Targeted Date | {str(issue['targeted_date'] or '').replace('|', '/')} |")
        print(f"| Updated | {str(issue['updated'] or '').replace('|', '/')} |")
        print(f"| Link | [Open]({issue['url']}) |")
        print()
        print("Description:")
        print(issue.get("description") or "No description.")
        print()
        print("Comments:")
        if not result["comments"]:
            print("No comments.")
        else:
            for comment in result["comments"]:
                prefix = " - ".join(part for part in [comment.get("created"), comment.get("author")] if part)
                if prefix:
                    print(f"- {prefix}: {comment.get('body') or '(empty)'}")
                else:
                    print(f"- {comment.get('body') or '(empty)'}")
        return

    projects = args or ["BILLING", "SEARCH", "FRESHID"]
    limit = int(os.environ.get("FR_EPIC_LIMIT", "3"))

    status_query = os.environ.get("FR_STATUS_QUERY", "").strip()
    results = []
    for project in projects:
        try:
            results.append(collect_epics(project, token, limit, status_query=status_query))
        except FreshreleaseError as exc:
            results.append({
                "project": str(project).upper(),
                "error": str(exc),
                "epic_type": None,
                "epics": [],
                "issue_type_candidates": [],
                "status_query": status_query or "",
                "allowed_statuses": [],
            })

    for result in results:
        print(f"## {result['project']}")
        if result.get("error"):
            print(f"Error: {result['error']}")
            print()
            continue
        if not result["epic_type"]:
            print("No Epic issue type found.")
            if result["issue_type_candidates"]:
                print("Issue type candidates:")
                for issue_type_id, label, name in result["issue_type_candidates"]:
                    print(f"- {issue_type_id}: {label} ({name})")
            print()
            continue

        epic_type_id, label, name = result["epic_type"]
        print(f"Epic type: {label} ({name}, id={epic_type_id})")
        if result["allowed_statuses"]:
            print(f"State filter: {', '.join(result['allowed_statuses'])}")
        if not result["epics"]:
            print("No epics found.")
            print()
            continue

        print("| Key | Title | Assigned User | Current State | Created Date | Targeted Date | Updated | Link |")
        print("|---|---|---|---|---|---|---|---|")
        for epic in result["epics"]:
            title = str(epic["title"] or "").replace("|", "/")
            owner = str(epic["assigned_user"] or "").replace("|", "/")
            status = str(epic["current_state"] or "").replace("|", "/")
            created = str(epic["created_date"] or "").replace("|", "/")
            targeted = str(epic["targeted_date"] or "").replace("|", "/")
            updated = str(epic["updated"] or "").replace("|", "/")
            link = f"[{epic['key']}]({epic['url']})" if epic.get("url") else ""
            print(f"| {epic['key']} | {title} | {owner} | {status} | {created} | {targeted} | {updated} | {link} |")
        print()


if __name__ == "__main__":
    main(sys.argv)
