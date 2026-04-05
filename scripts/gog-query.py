#!/usr/bin/env python3

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def resolve_gog_binary():
    configured = os.environ.get("GOG_BIN", "").strip()
    candidates = [
        configured,
        shutil.which("gog") or "",
        str(Path.home() / "bin" / "gog"),
        "/usr/local/bin/gog",
        "/usr/bin/gog",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    fail("gog CLI is not installed or not on PATH")


def run_gog(args):
    gog_dir = os.environ.get("GOG_CONFIG_DIR", "").strip()
    keyring_password = os.environ.get("GOG_KEYRING_PASSWORD", "").strip()
    if not gog_dir:
      fail("GOG_CONFIG_DIR is missing")
    if not keyring_password:
      fail("GOG_KEYRING_PASSWORD is missing")
    config_path = Path(gog_dir)
    if not (config_path / "config.json").exists():
      fail("gogcli config.json is missing")

    with tempfile.TemporaryDirectory(prefix="nemoclaw-gog-") as tmpdir:
        home = Path(tmpdir)
        (home / ".config").mkdir(parents=True, exist_ok=True)
        (home / ".config" / "gogcli").symlink_to(config_path)
        env = dict(os.environ)
        env["HOME"] = str(home)
        env["GOG_KEYRING_PASSWORD"] = keyring_password
        gog_bin = resolve_gog_binary()
        result = subprocess.run(
            [gog_bin, *args],
            text=True,
            capture_output=True,
            env=env,
            check=False,
            timeout=45,
        )
        if result.returncode != 0:
            fail((result.stderr or result.stdout or "gog failed").strip())
        return json.loads(result.stdout)


def parse_date(value):
    if not value:
        return None
    raw = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def format_date(value):
    dt = parse_date(value)
    if not dt:
        return ""
    return dt.strftime("%b %d, %Y")


def format_datetime(value):
    dt = parse_date(value)
    if not dt:
        return ""
    return dt.strftime("%b %d, %Y %I:%M %p")


def get_flag(args, name, default):
    if name not in args:
        return default
    index = args.index(name)
    if index + 1 >= len(args):
        return default
    return args[index + 1]


def normalize_text(value):
    return " ".join(str(value or "").strip().lower().split())


def rank_task(row):
    due = parse_date(row.get("raw_due"))
    due_rank = due.timestamp() if due else float("inf")
    untitled_penalty = 1 if row.get("is_untitled") else 0
    completed_penalty = 1 if row.get("status") == "Completed" else 0
    return (completed_penalty, untitled_penalty, due_rank, row.get("title", ""))


def select_task_lists(task_lists, list_query, prefer_personal):
    if not list_query and not prefer_personal:
        return task_lists
    if list_query:
        wanted = normalize_text(list_query)
        exact = [item for item in task_lists if normalize_text(item.get("title")) == wanted]
        if exact:
            return exact
        partial = [item for item in task_lists if wanted in normalize_text(item.get("title"))]
        if partial:
            return partial
        return task_lists
    if prefer_personal:
        personal = [
            item for item in task_lists
            if normalize_text(item.get("title")).endswith("s list")
            or normalize_text(item.get("title")) in {"my tasks", "personal", "personal tasks"}
        ]
        if personal:
            return personal
    return task_lists


def list_tasks(limit, status, list_query="", prefer_personal=False):
    task_lists = run_gog(["tasks", "lists", "-j", "--results-only"])
    task_lists = select_task_lists(task_lists, list_query, prefer_personal)
    rows = []
    for task_list in task_lists:
        task_list_id = task_list.get("id")
        title = task_list.get("title") or ""
        tasks = run_gog(["tasks", "list", task_list_id, "-j", "--results-only"])
        for task in tasks:
            task_status = task.get("status") or ""
            if status == "open" and task_status != "needsAction":
                continue
            if status == "completed" and task_status != "completed":
                continue
            task_title = (task.get("title") or "").strip()
            is_untitled = not task_title
            rows.append({
                "list": title,
                "title": task_title or "(untitled task)",
                "status": "Open" if task_status == "needsAction" else "Completed",
                "due": format_date(task.get("due")),
                "updated": format_date(task.get("updated")),
                "raw_due": task.get("due"),
                "link": task.get("webViewLink") or "",
                "is_untitled": is_untitled,
            })
    titled_rows = [row for row in rows if not row["is_untitled"]]
    rows = titled_rows or rows
    rows.sort(key=rank_task)
    rows = rows[:limit]
    if list_query:
        print(f"Task list filter: {list_query}")
    elif prefer_personal:
        print("Task list filter: personal")
    print("| List | Task | Status | Due | Updated | Link |")
    print("|---|---|---|---|---|---|")
    for row in rows:
        link = f"[Open]({row['link']})" if row["link"] else ""
        print(
            f"| {row['list'].replace('|', '/')} | {row['title'].replace('|', '/')} | "
            f"{row['status']} | {row['due']} | {row['updated']} | {link} |"
        )


def in_range(item, start, end):
    event_start = item.get("start", {}) or {}
    value = event_start.get("dateTime") or event_start.get("date")
    dt = parse_date(value)
    if not dt:
        return False
    return start <= dt <= end


def get_calendar_window(range_name):
    now = datetime.now().astimezone()
    if range_name == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1, seconds=-1)
        return start, end
    if range_name == "tomorrow":
        start = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1, seconds=-1)
        return start, end
    if range_name == "week":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=7)
        return start, end
    start = now
    end = now + timedelta(days=7)
    return start, end


def list_calendar(limit, range_name):
    events = run_gog(["calendar", "events", "primary", "-j", "--results-only"])
    start, end = get_calendar_window(range_name)
    rows = [event for event in events if in_range(event, start, end)]
    rows.sort(key=lambda event: (event.get("start", {}) or {}).get("dateTime") or (event.get("start", {}) or {}).get("date") or "")
    rows = rows[:limit]
    print("| Title | Start | End | Status | Link |")
    print("|---|---|---|---|---|")
    for event in rows:
        title = str(event.get("summary") or "(untitled)").replace("|", "/")
        start_value = format_datetime((event.get("start", {}) or {}).get("dateTime")) or format_date((event.get("start", {}) or {}).get("date"))
        end_value = format_datetime((event.get("end", {}) or {}).get("dateTime")) or format_date((event.get("end", {}) or {}).get("date"))
        status = str(event.get("status") or "").replace("|", "/")
        link = str(event.get("htmlLink") or "").replace("|", "/")
        link_cell = f"[Open]({link})" if link else ""
        print(f"| {title} | {start_value} | {end_value} | {status} | {link_cell} |")


def main(argv):
    args = argv[1:]
    if "--tasks" in args:
        limit = int(get_flag(args, "--limit", "5"))
        status = get_flag(args, "--status", "open")
        list_query = get_flag(args, "--list-query", "")
        prefer_personal = get_flag(args, "--prefer-personal", "0") == "1"
        list_tasks(limit, status, list_query=list_query, prefer_personal=prefer_personal)
        return
    if "--calendar" in args:
        limit = int(get_flag(args, "--limit", "5"))
        range_name = get_flag(args, "--range", "upcoming")
        list_calendar(limit, range_name)
        return
    fail("Usage: gog-query.py --tasks|--calendar [--limit N] [--status open|completed|all] [--range today|tomorrow|week|upcoming]")


if __name__ == "__main__":
    main(sys.argv)
