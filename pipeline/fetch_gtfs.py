#!/usr/bin/env python3
"""Fetch the Delhi OTD **static** GTFS files.

Why this is a script that takes arguments rather than something the build just does:
OTD does not serve the static files from a plain URL. The files themselves live on
`traffickarma.iiitd.edu.in:9010`, which is unreachable from outside their network (probed:
connection refused on both port 80 and 9010). The only working route is a **POST to
https://otd.delhi.gov.in/data/static/** behind a modal form that requires:

  - usageType   Commercial | NonCommercial
  - purpose     Academia | R&D | Business | Journalistic | Govt Use | Other  (one or more)
  - name        a real name
  - email       a real email address
  - agreement   a terms checkbox

Those last three are a person's identity and a declaration about how the data will be used. They
are not mine to invent or to guess, so they are required arguments and the script refuses to run
without them. It also refuses obvious placeholders — submitting "test@example.com" to a government
data portal is worse than not downloading the data.

Four datasets are available: stops, routes, trips, stop_times. Note what is NOT: no shapes.txt, so
GTFS gives no route geometry, and no calendar.txt, so no service calendar. What it does give is
**real scheduled stop times**, which is the thing worth having — the scenario model currently runs
on an assumed headway per route, and this replaces that assumption with the operator's own timetable.

Usage:
  python pipeline/fetch_gtfs.py --name "Your Name" --email you@example.org \\
      --usage NonCommercial --purpose "R&D" [--datasets stops,routes,trips,stop_times]

Output: spike/_raw/gtfs/<dataset>.<ext> plus a fetch-report.json recording exactly what was
declared, so the provenance of this download is auditable later.
"""
from __future__ import annotations
import argparse, datetime, json, pathlib, re, sys, urllib.error, urllib.parse, urllib.request
import http.cookiejar

PAGE = "https://otd.delhi.gov.in/data/static/"
DATASETS = ("stops", "routes", "trips", "stop_times")
USAGE = ("Commercial", "NonCommercial")
PURPOSES = ("Academia", "R&D", "Business", "Journalistic", "Govt Use", "Other")
OUT = pathlib.Path("spike/_raw/gtfs")

PLACEHOLDERS = re.compile(
    r"(example\.(com|org|net)|test@|foo@|bar@|no-?reply|asdf|xxx|dummy|placeholder|"
    r"^a@a\.|your-?name|yourname|john ?doe|jane ?doe)", re.I)


def opener_with_cookies():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def get_csrf(op) -> tuple[str, str]:
    """The form is Django's, so it needs both the hidden token and the matching cookie."""
    req = urllib.request.Request(PAGE, headers={"user-agent": "delhi-pulse-twin/0.1 (+pipeline)"})
    with op.open(req, timeout=60) as r:
        html = r.read().decode("utf-8", "replace")
    m = re.search(r'name=["\']csrfmiddlewaretoken["\']\s+[^>]*value=["\']([^"\']+)', html) \
        or re.search(r'value=["\']([^"\']+)["\']\s+name=["\']csrfmiddlewaretoken', html)
    if not m:
        raise SystemExit("could not find a csrfmiddlewaretoken on the OTD static page — the form "
                         "has changed; re-inspect https://otd.delhi.gov.in/data/static/")
    return m.group(1), html


def fetch(op, token: str, dataset: str, a) -> tuple[bytes, str]:
    fields = [("csrfmiddlewaretoken", token), ("dataDownloaded", dataset),
              ("usageType", a.usage), ("name", a.name), ("email", a.email)]
    for p in a.purpose:
        fields.append(("purpose", p))
    # the form's required agreement checkbox is unnamed in the markup; Django ignores unknown
    # fields, and sending it under the conventional name is the closest honest equivalent
    fields.append(("agree", "on"))
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(PAGE, data=body, headers={
        "content-type": "application/x-www-form-urlencoded",
        "referer": PAGE,
        "origin": "https://otd.delhi.gov.in",
        "user-agent": "delhi-pulse-twin/0.1 (+pipeline)",
    })
    with op.open(req, timeout=180) as r:
        return r.read(), (r.headers.get("content-type") or "").lower()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="the name to declare on the OTD form")
    ap.add_argument("--email", required=True, help="the email to declare on the OTD form")
    ap.add_argument("--usage", required=True, choices=USAGE)
    ap.add_argument("--purpose", required=True, action="append", choices=PURPOSES,
                    help="repeatable; at least one")
    ap.add_argument("--datasets", default=",".join(DATASETS))
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()

    if PLACEHOLDERS.search(a.email) or PLACEHOLDERS.search(a.name):
        print("refusing to submit a placeholder name or email to a government data portal.\n"
              "Pass the real details of whoever is accepting the terms.", file=sys.stderr)
        return 2
    if "@" not in a.email or "." not in a.email.split("@")[-1]:
        print(f"that does not look like an email address: {a.email!r}", file=sys.stderr)
        return 2

    want = [d.strip() for d in a.datasets.split(",") if d.strip()]
    bad = [d for d in want if d not in DATASETS]
    if bad:
        print(f"unknown dataset(s) {bad}; choose from {list(DATASETS)}", file=sys.stderr)
        return 2

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    op, _jar = opener_with_cookies()
    token, _html = get_csrf(op)
    print(f"  csrf token acquired; declaring usage={a.usage} purpose={a.purpose}")

    report = {"fetched_at": datetime.datetime.now().astimezone().isoformat(),
              "source": PAGE,
              "declared": {"name": a.name, "email": a.email,
                           "usageType": a.usage, "purpose": a.purpose},
              "note": "These declarations were submitted to the OTD download form by "
                      "pipeline/fetch_gtfs.py at the operator's request. Recorded here so the "
                      "provenance of this download is auditable.",
              "files": []}

    for d in want:
        try:
            body, ctype = fetch(op, token, d, a)
        except urllib.error.HTTPError as e:
            print(f"  {d:12} HTTP {e.code} — {e.reason}", file=sys.stderr)
            report["files"].append({"dataset": d, "error": f"HTTP {e.code} {e.reason}"})
            continue
        except Exception as e:                                  # noqa: BLE001
            print(f"  {d:12} failed: {e}", file=sys.stderr)
            report["files"].append({"dataset": d, "error": str(e)})
            continue

        ext = "zip" if body[:2] == b"PK" else ("txt" if b"," in body[:400] else "bin")
        if ext == "bin" and b"<html" in body[:400].lower():
            # the form came back instead of a file: almost always a validation failure
            snippet = re.sub(rb"<[^>]+>", b" ", body[:1500]).decode("utf-8", "replace")
            snippet = " ".join(snippet.split())[:300]
            print(f"  {d:12} returned an HTML page, not a file. The form likely rejected the "
                  f"submission: {snippet}", file=sys.stderr)
            report["files"].append({"dataset": d, "error": "html returned", "snippet": snippet})
            continue
        path = out / f"{d}.{ext}"
        path.write_bytes(body)
        print(f"  {d:12} {len(body):>12,} bytes  {ctype or '?':32} -> {path}")
        report["files"].append({"dataset": d, "bytes": len(body),
                                "content_type": ctype, "path": str(path)})

    (out / "fetch-report.json").write_text(json.dumps(report, indent=2) + "\n")
    ok = [f for f in report["files"] if "bytes" in f]
    print(f"\n  {len(ok)} of {len(want)} datasets downloaded into {out}/")
    if not ok:
        print("  nothing downloaded — see the errors above.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
