#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Yahoo Mail CLI — read and send email via IMAP/SMTP.
# Supports HTTP CONNECT proxy tunneling for sandboxed environments.
#
# Usage:
#   yahoo-mail inbox [--count N] [--unread]
#   yahoo-mail read <message-id>
#   yahoo-mail send --to <addr> --subject <subj> --body <body> [--cc <addr>]
#   yahoo-mail search <query> [--count N]
#
# Env vars:
#   YAHOO_EMAIL    — Yahoo email address
#   YAHOO_APP_PWD  — Yahoo app password
#   https_proxy    — HTTP proxy (auto-detected, used for CONNECT tunneling)

import argparse
import email
import email.utils
import imaplib
import os
import smtplib
import socket
import ssl
import sys
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import decode_header
from urllib.parse import urlparse

IMAP_HOST = "imap.mail.yahoo.com"
IMAP_PORT = 993
SMTP_HOST = "smtp.mail.yahoo.com"
SMTP_PORT = 465


def _proxy_tunnel(host, port):
    """Create an SSL socket through the HTTP CONNECT proxy."""
    proxy_url = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    if not proxy_url:
        sock = socket.create_connection((host, port), timeout=30)
        return ssl.create_default_context().wrap_socket(sock, server_hostname=host)

    parsed = urlparse(proxy_url)
    proxy_host = parsed.hostname
    proxy_port = parsed.port or 3128

    sock = socket.create_connection((proxy_host, proxy_port), timeout=30)
    sock.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())

    response = b""
    while b"\r\n\r\n" not in response:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError(f"Proxy closed connection during CONNECT to {host}:{port}")
        response += chunk

    status_line = response.split(b"\r\n")[0].decode()
    if "200" not in status_line:
        raise ConnectionError(f"Proxy CONNECT failed: {status_line}")

    return ssl.create_default_context().wrap_socket(sock, server_hostname=host)


def open_imap():
    """Connect to Yahoo IMAP. Uses proxy tunnel if https_proxy is set, else direct."""
    proxy_url = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    if not proxy_url:
        return imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    # Proxy path: tunnel through HTTP CONNECT
    ssl_sock = _proxy_tunnel(IMAP_HOST, IMAP_PORT)
    imap = imaplib.IMAP4(IMAP_HOST)
    imap.sock = ssl_sock
    imap.file = ssl_sock.makefile("rb")
    imap.file.readline()  # consume greeting
    return imap


def open_smtp():
    """Connect to Yahoo SMTP. Uses proxy tunnel if https_proxy is set, else direct."""
    proxy_url = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    if not proxy_url:
        return smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT)
    # Proxy path: tunnel through HTTP CONNECT
    ssl_sock = _proxy_tunnel(SMTP_HOST, SMTP_PORT)
    smtp = smtplib.SMTP()
    smtp.sock = ssl_sock
    smtp.file = ssl_sock.makefile("rb")
    code, msg = smtp.getreply()
    if code != 220:
        raise smtplib.SMTPConnectError(code, msg)
    smtp.ehlo()
    return smtp


def get_creds():
    addr = os.environ.get("YAHOO_EMAIL")
    pwd = os.environ.get("YAHOO_APP_PWD")
    if not addr or not pwd:
        print("Error: YAHOO_EMAIL and YAHOO_APP_PWD must be set", file=sys.stderr)
        sys.exit(1)
    return addr, pwd


def decode_hdr(value):
    if value is None:
        return ""
    parts = decode_header(value)
    result = []
    for data, charset in parts:
        if isinstance(data, bytes):
            result.append(data.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(data)
    return "".join(result)


def get_body(msg):
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    return payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                payload = part.get_payload(decode=True)
                if payload:
                    return "[HTML] " + payload.decode(part.get_content_charset() or "utf-8", errors="replace")[:2000]
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            return payload.decode(msg.get_content_charset() or "utf-8", errors="replace")
    return "(no body)"


def cmd_inbox(args):
    addr, pwd = get_creds()
    imap = open_imap()
    try:
        imap.login(addr, pwd)
        imap.select("INBOX", readonly=True)
        _, data = imap.search(None, "UNSEEN" if args.unread else "ALL")
        ids = data[0].split()
        if not ids:
            print("No messages found.")
            return
        latest = ids[-(args.count):]
        latest.reverse()
        print(f"{'ID':>6}  {'Date':20}  {'From':30}  Subject")
        print("-" * 100)
        for mid in latest:
            _, msg_data = imap.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)
            frm = decode_hdr(msg.get("From", ""))[:30]
            subj = decode_hdr(msg.get("Subject", ""))[:60]
            date = decode_hdr(msg.get("Date", ""))[:20]
            print(f"{mid.decode():>6}  {date:20}  {frm:30}  {subj}")
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def cmd_read(args):
    addr, pwd = get_creds()
    imap = open_imap()
    try:
        imap.login(addr, pwd)
        imap.select("INBOX", readonly=True)
        _, msg_data = imap.fetch(args.message_id.encode(), "(RFC822)")
        if not msg_data or not msg_data[0]:
            print(f"Message {args.message_id} not found.")
            return
        raw = msg_data[0][1]
        msg = email.message_from_bytes(raw)
        print(f"From:    {decode_hdr(msg.get('From', ''))}")
        print(f"To:      {decode_hdr(msg.get('To', ''))}")
        print(f"Date:    {decode_hdr(msg.get('Date', ''))}")
        print(f"Subject: {decode_hdr(msg.get('Subject', ''))}")
        print(f"\n{get_body(msg)}")
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def cmd_send(args):
    addr, pwd = get_creds()
    msg = MIMEMultipart()
    msg["From"] = addr
    msg["To"] = args.to
    msg["Subject"] = args.subject
    if args.cc:
        msg["Cc"] = args.cc
    msg.attach(MIMEText(args.body, "plain"))
    smtp = open_smtp()
    try:
        smtp.login(addr, pwd)
        recipients = [args.to]
        if args.cc:
            recipients.extend([a.strip() for a in args.cc.split(",")])
        smtp.sendmail(addr, recipients, msg.as_string())
        print(f"Sent to {args.to}" + (f" (cc: {args.cc})" if args.cc else ""))
    finally:
        try:
            smtp.quit()
        except Exception:
            pass


def cmd_search(args):
    addr, pwd = get_creds()
    query = " ".join(args.query)
    imap = open_imap()
    try:
        imap.login(addr, pwd)
        imap.select("INBOX", readonly=True)
        _, data = imap.search(None, f'(OR (SUBJECT "{query}") (FROM "{query}"))')
        ids = data[0].split()
        if not ids:
            print(f"No messages matching '{query}'.")
            return
        latest = ids[-(args.count):]
        latest.reverse()
        print(f"{'ID':>6}  {'Date':20}  {'From':30}  Subject")
        print("-" * 100)
        for mid in latest:
            _, msg_data = imap.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)
            frm = decode_hdr(msg.get("From", ""))[:30]
            subj = decode_hdr(msg.get("Subject", ""))[:60]
            date = decode_hdr(msg.get("Date", ""))[:20]
            print(f"{mid.decode():>6}  {date:20}  {frm:30}  {subj}")
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="Yahoo Mail CLI")
    sub = parser.add_subparsers(dest="command")

    p_inbox = sub.add_parser("inbox", help="List inbox messages")
    p_inbox.add_argument("--count", type=int, default=10)
    p_inbox.add_argument("--unread", action="store_true")

    p_read = sub.add_parser("read", help="Read a message")
    p_read.add_argument("message_id")

    p_send = sub.add_parser("send", help="Send an email")
    p_send.add_argument("--to", required=True)
    p_send.add_argument("--subject", required=True)
    p_send.add_argument("--body", required=True)
    p_send.add_argument("--cc")

    p_search = sub.add_parser("search", help="Search messages")
    p_search.add_argument("query", nargs="+")
    p_search.add_argument("--count", type=int, default=10)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    {"inbox": cmd_inbox, "read": cmd_read, "send": cmd_send, "search": cmd_search}[args.command](args)


if __name__ == "__main__":
    main()
