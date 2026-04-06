#!/usr/bin/env python3

import json
import os
import subprocess
import sys
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def parse_args(argv):
    args = {"mode": "inbox", "count": 10, "query": "", "unread": False, "year": None}
    items = list(argv[1:])
    while items:
      item = items.pop(0)
      if item == "--query":
          if not items:
              fail("--query requires a value")
          args["mode"] = "search"
          args["query"] = items.pop(0).strip()
      elif item == "--count":
          if not items:
              fail("--count requires a value")
          args["count"] = max(1, min(int(items.pop(0)), 25))
      elif item == "--unread":
          args["unread"] = True
      elif item == "--inbox":
          args["mode"] = "inbox"
      elif item == "--year":
          if not items:
              fail("--year requires a value")
          args["year"] = int(items.pop(0))
      else:
          fail(f"Unknown argument: {item}")
    return args


def parse_dt(value):
    if not value:
        return None
    text = str(value).strip()
    for parser in (
        lambda x: datetime.fromisoformat(x.replace("Z", "+00:00")),
        parsedate_to_datetime,
        lambda x: datetime.strptime(x, "%Y-%m-%d %H:%M"),
    ):
        try:
            return parser(text)
        except Exception:
            pass
    return None


def format_date(value):
    dt = parse_dt(value)
    if not dt:
        return str(value or "")
    return dt.strftime("%b %d, %Y")


def run_yahoo(args):
    email = os.environ.get("YAHOO_EMAIL", "").strip()
    pwd = os.environ.get("YAHOO_APP_PWD", "").strip()
    if not email or not pwd:
        return []
    cmd = ["python3", str(Path(__file__).with_name("yahoo-mail.py")), "--json", *args]
    result = subprocess.run(cmd, text=True, capture_output=True, env=os.environ, check=False, timeout=30)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "yahoo-mail failed").strip())
    rows = json.loads(result.stdout or "[]")
    return [
        {
            "source": "Yahoo",
            "raw_date": item.get("date") or "",
            "date": format_date(item.get("date")),
            "from": item.get("from") or "",
            "subject": item.get("subject") or "",
        }
        for item in rows
    ]


def print_rows(rows):
    if not rows:
        print("No messages found.")
        return
    print("| Source | Date | From | Subject |")
    print("|---|---|---|---|")
    for row in rows:
        print(
            f"| {str(row.get('source') or '').replace('|', '/')} | "
            f"{str(row.get('date') or '').replace('|', '/')} | "
            f"{str(row.get('from') or '').replace('|', '/')} | "
            f"{str(row.get('subject') or '').replace('|', '/')} |"
        )


def filter_rows(rows, year=None):
    filtered = rows
    if year:
        filtered = [
            row for row in filtered
            if parse_dt(row.get("raw_date")) and parse_dt(row.get("raw_date")).year == year
        ]
    filtered.sort(key=lambda row: parse_dt(row.get("raw_date")) or datetime.min, reverse=True)
    return filtered


def main(argv):
    opts = parse_args(argv)
    rows = []
    errors = []
    try:
        if opts["mode"] == "search" and opts["query"]:
            rows.extend(run_yahoo(["search", opts["query"], "--count", str(opts["count"])]))
        else:
            yahoo_args = ["inbox", "--count", str(opts["count"])]
            if opts["unread"]:
                yahoo_args.append("--unread")
            rows.extend(run_yahoo(yahoo_args))
    except Exception as exc:
        errors.append(f"Yahoo: {exc}")

    if not rows and errors:
        fail(" ; ".join(errors))
    rows = filter_rows(rows, year=opts["year"])
    print_rows(rows[: opts["count"] * 2])


if __name__ == "__main__":
    main(sys.argv)
