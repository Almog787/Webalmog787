import json
import os
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: scrapling_fetch.py <target_url> <extracted_dir>", file=sys.stderr)
        return 1

    target_url = sys.argv[1]
    extracted_dir = Path(sys.argv[2])

    try:
        from scrapling.defaults import Fetcher, StealthyFetcher
    except Exception as exc:
        print(f"[Scrapling] Not installed or unavailable: {exc}", file=sys.stderr)
        return 2

    html_content = ""
    title = ""
    status = 200
    mode = "StealthyFetcher"

    try:
        page = StealthyFetcher.fetch(
            target_url,
            headless=True,
            network_idle=True,
        )
        html_content = getattr(page, "html_content", "") or str(page)
        title = page.css("title::text").get() or ""
        status = getattr(page, "status", 200) or 200
    except Exception as stealth_exc:
        print(f"[Scrapling] StealthyFetcher failed ({stealth_exc}), trying HTTP Fetcher...", file=sys.stderr)
        mode = "Fetcher"
        try:
            page = Fetcher.get(target_url, stealthy_headers=True)
            html_content = getattr(page, "html_content", "") or str(page)
            title = page.css("title::text").get() or ""
            status = getattr(page, "status", 200) or 200
        except Exception as fetch_exc:
            print(f"[Scrapling] Fetcher failed: {fetch_exc}", file=sys.stderr)
            return 3

    if not html_content.strip():
        print("[Scrapling] Empty response body.", file=sys.stderr)
        return 4

    page_dir = extracted_dir / "pages" / "index"
    page_dir.mkdir(parents=True, exist_ok=True)
    (page_dir / "page.html").write_text(html_content, encoding="utf-8")

    summary = {
        "url": target_url,
        "title": title,
        "status": status,
        "mode": mode,
        "bytes": len(html_content.encode("utf-8")),
    }
    (page_dir / "scrapling-meta.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(f"[Scrapling] Recovered {summary['bytes']} bytes via {mode} (HTTP {status}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
