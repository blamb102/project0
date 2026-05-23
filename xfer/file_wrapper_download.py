#!/usr/bin/env python3
"""
Direct-download USPTO ODP Patent File Wrapper (file history) documents (NO patent-client),
 and build a dataframe with document metadata.

Key endpoints used:
  - Search:   https://api.uspto.gov/api/v1/patent/applications/search  (ODP getting-started shows this base)  [1](https://data.uspto.gov/apis)
  - Docs:     https://api.uspto.gov/api/v1/patent/applications/{appNumber}/documents                           [2](https://pypi.org/project/uspto-odp/)

Auth header:
  - X-API-KEY: <YOUR_API_KEY> (example shown in getting-started)                                                [1](https://data.uspto.gov/apis)

Outputs (default): ./data/<application_number>/
  - documents/                       (downloaded PDFs)
  - file_history_merged.pdf      (merged  PDF in chronological order)
  - file_history_documents.csv
  - file_history_documents.parquet   (if pyarrow installed)

Notes:
  - Corporate networks may require a proxy; this script supports --proxy and also uses trust_env=True.
"""

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd
import requests


from concurrent.futures import ThreadPoolExecutor, as_completed

MAX_WORKERS = 8  # try 8–16 depending on your network


# Types to skip (customize as needed)
SKIP_DOC_CODES = {
    "FOR",        # foreign references
    "NPL",        # non-patent literature (optional)
    #"IDS",        # IDS (optional depending on use)
    "REF.OTHER"
}


# ============================
# HARD-CODED ODP API KEY (EDIT THIS)
# ============================
ODP_API_KEY = "fzdpdbwhxwatjjyzmnbdmszspvwksr"

# ----------------------------
# Basic normalization helpers
# ----------------------------

def normalize_digits(s: str) -> str:
    return re.sub(r"\D+", "", (s or "").strip())

def looks_like_application(user_id: str) -> bool:
    """Heuristic: application numbers often 8 digits (e.g., 18724663) or written with '/,'
    like 18/724,663."""
    if not user_id:
        return False
    if "/" in user_id:
        return True
    d = normalize_digits(user_id)
    return len(d) == 8

def looks_like_patent(user_id: str) -> bool:
    """Patent numbers may be digits, or prefixed (D, RE, PP, etc.)."""
    if not user_id:
        return False
    s = user_id.strip().upper()
    if re.match(r"^(RE|PP|D|AI|X|H|T)\s*\d+", s):
        return True
    d = normalize_digits(s)
    return len(d) in (6, 7, 8, 9, 10) and not looks_like_application(s)

def parse_date_any(x):
    if not x:
        return None

    if isinstance(x, str):
        try:
            # Remove timezone offset (e.g., -0400)
            x_clean = re.sub(r"[-+]\d{4}$", "", x)
            return dt.datetime.fromisoformat(x_clean).date()
        except Exception:
            pass

    return None

# ----------------------------
# ODP HTTP client
# ----------------------------

ODP_BASE = "https://api.uspto.gov/api/v1/patent/applications"
SEARCH_URL = f"{ODP_BASE}/search"  # shown in ODP getting-started curl example base [1](https://data.uspto.gov/apis)

def build_session(proxy: Optional[str] = None) -> requests.Session:
    s = requests.Session()
    s.trust_env = True  # pick up HTTPS_PROXY/HTTP_PROXY if set by your environment


    adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20)
    s.mount("https://", adapter)

    if proxy:
        s.proxies.update({"http": proxy, "https": proxy})
    return s

def odp_headers() -> Dict[str, str]:
    if not ODP_API_KEY or ODP_API_KEY == "YOUR_API_KEY_HERE":
        raise ValueError("Hard-coded ODP_API_KEY is not set. Edit ODP_API_KEY at top of script.")
    return {
        "accept": "application/json",
        "X-API-KEY": ODP_API_KEY,  # header format described in getting-started [1](https://data.uspto.gov/apis)
    }

def http_get_json(sess: requests.Session, url: str, params: Optional[Dict[str, Any]] = None, timeout: int = 60) -> Any:
    r = sess.get(url, headers=odp_headers(), params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()

def http_post_json(sess: requests.Session, url: str, payload: Dict[str, Any], timeout: int = 60) -> Any:
    r = sess.post(url, headers=odp_headers(), json=payload, timeout=timeout)
    r.raise_for_status()
    return r.json()


# ----------------------------
# Application number resolution
# ----------------------------

def extract_application_number(obj: Any) -> Optional[str]:
    """
    Best-effort extraction: scans nested dict/list for keys commonly used to represent app numbers.
    We avoid assuming exact response schema.
    """
    candidate_keys = {
        "applicationNumberText", "applicationNumber", "application_number",
        "applicationId", "application_id"
    }

    def walk(x: Any) -> Iterable[Any]:
        if isinstance(x, dict):
            yield x
            for v in x.values():
                yield from walk(v)
        elif isinstance(x, list):
            for it in x:
                yield from walk(it)

    for d in walk(obj):
        if isinstance(d, dict):
            for k in candidate_keys:
                if k in d and d[k]:
                    cand = normalize_digits(str(d[k]))
                    if len(cand) == 8:
                        return cand
    return None

def find_application_from_patent(sess: requests.Session, patent_no: str) -> Optional[str]:
    """
    Uses the /search endpoint to find a record matching the patent number and extracts app number.
    The ODP getting-started page shows using this endpoint with X-API-KEY. [1](https://data.uspto.gov/apis)
    """
    p = normalize_digits(patent_no)
    if not p:
        return None

    # Try multiple query parameter shapes; exact query syntax can vary.
    attempts_get = [
        {"q": f"patentNumber:{p}"},
        {"q": f"patent_number:{p}"},
        {"q": f"patentNo:{p}"},
        {"q": p},  # fallback: raw term
    ]

    for params in attempts_get:
        try:
            js = http_get_json(sess, SEARCH_URL, params=params)
            app = extract_application_number(js)
            if app:
                return app
        except Exception:
            pass

    # Try POST variants
    attempts_post = [
        {"q": f"patentNumber:{p}"},
        {"query": f"patentNumber:{p}"},
        {"searchText": f"patentNumber:{p}"},
        {"q": p},
    ]

    for payload in attempts_post:
        try:
            js = http_post_json(sess, SEARCH_URL, payload=payload)
            app = extract_application_number(js)
            if app:
                return app
        except Exception:
            pass

    return None

# ----------------------------
# Documents endpoint + downloads
# ----------------------------

def documents_url(app_no: str) -> str:
    # Documents endpoint path is listed as supported under /{appNumber}/documents [2](https://pypi.org/project/uspto-odp/)
    return f"{ODP_BASE}/{app_no}/documents"

def extract_documents_list(js):
    """
    Extract documents from confirmed ODP schema.
    """
    if "documentBag" in js and isinstance(js["documentBag"], list):
        return js["documentBag"]
    return []

def guess_download_url(doc):
    """
    Extract download URL from ODP document structure.
    """
    options = doc.get("downloadOptionBag", [])
    if isinstance(options, list) and options:
        for opt in options:
            if opt.get("downloadUrl"):
                return opt["downloadUrl"]
    return None


def best_doc_date(doc):
    return parse_date_any(doc.get("officialDate"))


def safe_filename(s: str) -> str:
    s = re.sub(r"[^\w\-. ]+", "_", s).strip()
    s = re.sub(r"\s+", " ", s)
    return s[:180] if len(s) > 180 else s

def download_file(sess, url, path):
    headers = {
        "X-API-KEY": ODP_API_KEY,
        "accept": "application/pdf"
    }

    with sess.get(url, headers=headers, stream=True, timeout=60) as r:
        r.raise_for_status()

        with open(path, "wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                f.write(chunk)

        if not is_valid_pdf(path):
            print(f"Invalid PDF downloaded: {path}")
            raise ValueError(f"Invalid PDF downloaded: {url}")



def should_skip_doc(doc):   
    code = doc.get("documentCode", "")
    if not code:
        return False

    # Normalize
    code = code.upper()

    # Skip if code starts with any excluded prefix
    return any(code.startswith(skip) for skip in SKIP_DOC_CODES)

def merge_pdfs_in_order(df, merged_out):
    merged_out.parent.mkdir(parents=True, exist_ok=True)

    try:
        from PyPDF2 import PdfMerger
        merger = PdfMerger()

        def format_date(doc_date):
            s = doc_date
            if not s:
                return "UNKNOWN"
            s_clean = re.sub(r"[-+]\d{4}$", "", s)
            try:
                return dt.datetime.fromisoformat(s_clean).strftime("%Y-%m-%d")
            except Exception:
                return "UNKNOWN"

        for idx, row in df.iterrows():
            p = Path(row["downloaded_path"])
            if p and p.exists():
                date_str = format_date(row["doc_date"])
                code = row["document_code"]
                desc = row["document_description"]
                short_desc = desc[:50] if desc else row["document_code"]
                merger.append(
                    str(p),
                    import_outline=False,
                    outline_item=f"{date_str} | {code} - {short_desc}"
                )

        with open(merged_out, "wb") as f:
            merger.write(f)

        merger.close()

    except Exception as e:
        sys.stderr.write(f"[WARN] Merge failed: {e}\n")


def is_valid_pdf(path):
    if not path.exists() or path.stat().st_size < 1000:
        return False

    try:
        with open(path, "rb") as f:
            header = f.read(5)
            f.seek(-20, 2)  # go to end
            tail = f.read()

        return header.startswith(b"%PDF") and b"%%EOF" in tail

    except Exception:
        return False


def extract_ifw_metadata(app_no, docs_sorted, is_download, docs_dir):

    rows: List[Dict[str, Any]] = []

    for idx, doc in enumerate(docs_sorted, start=1):
        url = guess_download_url(doc)
        doc_date = best_doc_date(doc)
        doc_code = doc.get("documentCode") or doc.get("document_code") or doc.get("code")
        doc_desc = doc.get("documentCodeDescriptionText") or doc.get("document_code_description") or doc.get("description")
        doc_id = doc.get("documentIdentifier") or doc.get("document_identifier") or doc.get("id")
        date_part = doc_date.isoformat() if doc_date else "unknown-date"
        name_parts = [app_no, date_part, str(doc_code or "DOC"), str(doc_id or idx)]
        filename = safe_filename(" - ".join(name_parts)) + ".pdf"
        downloaded_path = docs_dir / filename if is_download else None
        rows.append({
            "order_chronological": idx,
            "application_number": app_no,
            "doc_date": doc_date.isoformat() if doc_date else None,
            "document_code": doc_code,
            "document_description": doc_desc,
            "document_identifier": doc_id,
            "download_url": url,
            "downloaded_path": str(downloaded_path) if downloaded_path else None,
            # preserve raw metadata (helpful for later schema tuning)
            "raw_metadata_json": json.dumps(doc, ensure_ascii=False),
         })
    return pd.DataFrame(rows)

# ----------------------------
# Main
# ----------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("id", nargs="?", help="Patent number or 8-digit application number (or 18/724,663 style)")
    ap.add_argument("--download", default=False, help="Whether to download pdf version of FH")
    args = ap.parse_args()

    user_id = args.id or input("Enter patent number or application number: ").strip()

    sess = build_session(proxy=None)

    # Determine application number
    if looks_like_application(user_id):
        app_no = normalize_digits(user_id)
    elif looks_like_patent(user_id):
        app_no = find_application_from_patent(sess, user_id)
        if not app_no:
            raise ValueError("Could not resolve an 8-digit application number from the provided patent number via ODP /search.")
    else:
        # fallback: treat as digits
        app_no = normalize_digits(user_id)

    if not app_no or len(app_no) != 8:
        raise ValueError("Application number must be 8 digits after normalization (e.g., 18724663).")

    out_dir = Path("./data") / app_no
    docs_dir = out_dir / "documents"
    docs_dir.mkdir(parents=True, exist_ok=True)

    # Fetch documents list
    js = http_get_json(sess, documents_url(app_no))
    
    with open("debug_odp_response.json", "w") as f:
        json.dump(js, f, indent=2)

    docs = extract_documents_list(js)

    if not docs:
        raise ValueError("No documents found (or response schema not recognized). Save the raw JSON and inspect if needed.")

    # Sort oldest -> newest
    def sort_key(d: Dict[str, Any]):
        dd = best_doc_date(d) or dt.date(1900, 1, 1)
        code = str(d.get("documentCode") or d.get("document_code") or d.get("code") or "")
        ident = str(d.get("documentIdentifier") or d.get("document_identifier") or d.get("id") or "")
        return (dd, code, ident)
    docs_sorted = sorted(docs, key=lambda d: best_doc_date(d) or dt.date(1900,1,1))
    #docs_sorted = sorted(docs, key=lambda d: sort_key)

    # filter certain types of docs like foreign references
    filtered_docs = []    
    for doc in docs_sorted:
        if should_skip_doc(doc):
            #print(f"[SKIP] {doc.get('documentCode')} - {doc.get('documentCodeDescriptionText')}")
            continue
        filtered_docs.append(doc)
    docs_sorted = filtered_docs

    #store the docs in a dataframe 
    df_docs = extract_ifw_metadata(app_no, docs_sorted, args.download, docs_dir)

    # Save DF
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "file_history_documents.csv"
    df_docs.to_csv(csv_path, index=False)
    parquet_path = out_dir / "file_history_documents.parquet"
    try:
        df_docs.to_parquet(parquet_path, index=False)
    except Exception:
        pass

    #download documents
    downloaded_pairs = [] 
    def download_one(row):
        idx = row["order_chronological"]
        url = row["download_url"]
        downloaded_path = Path(row["downloaded_path"])
        if not url:
            print(f"[WARN] No URL for doc {idx}")
            return idx, None

        # ✅ SKIP LOGIC)        
        if downloaded_path.exists():
            if downloaded_path.stat().st_size > 1000:   # avoid corrupt/empty files
                # print(f"[SKIP] Already exists: {downloaded_path.name}")  # optional
                return idx, downloaded_path
            else:
                print(f"[WARN] Re-downloading corrupt file: {downloaded_path.name}")

        try:
            download_file(sess, url, downloaded_path)
    
            # ✅ sanity check: file exists and not empty
            if is_valid_pdf(downloaded_path):
                downloaded_pairs.append((downloaded_path, row))
                return idx, downloaded_path
            else:
                print(f"[WARN] invalid PDF: {path}")
                return idx, None
    
        except Exception as e:
            #print(f"[ERROR] Download failed: {url}")
            return idx, None

    pdf_paths_ordered = [None] * len(docs_sorted)

    mask = [False] * len(df_docs)
    if args.download:
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(download_one, row)
                for row in df_docs.to_dict(orient='records')
            ]
        
            for future in as_completed(futures):
                idx, downloaded_path = future.result()
                if downloaded_path:
                    mask[idx-1] = True
    df_docs_downloaded = df_docs[mask]

    # Merge PDFs in chronological order
    merged = out_dir / "file_history_merged.pdf"

    merge_pdfs_in_order(df_docs_downloaded, merged)

    print(f"[OK] Application: {app_no}")
    print(f"[OK] Saved: {csv_path}")
    if parquet_path.exists():
        print(f"[OK] Saved: {parquet_path}")
    merged = out_dir / "file_history_merged.pdf"
    if merged.exists():
        print(f"[OK] Saved: {merged}")
    else:
        print("[INFO] No merged PDF produced (no PDFs downloaded or merge failed).")


if __name__ == "__main__":
    main()

