#!/usr/bin/env python3

import argparse
import os
import json
import time
import re
import requests
import pandas as pd
import networkx as nx

BASE = "https://api.uspto.gov/api/v1/patent/applications"
APP_RE = re.compile(r"\b\d{8}\b")
USPTO_API_KEY="fzdpdbwhxwatjjyzmnbdmszspvwksr"

# Directories
DATA_DIR = os.path.join(".", "data")
OUTPUT_DIR = os.path.join(".", "output")

#Debug
DEBUG_DIR = "debug_continuity_json"
os.makedirs(DEBUG_DIR, exist_ok=True)

FIELD_MAP = {
    "application_number": ["applicationnumbertext"],
    "filing_date": ["filingdate"],
    "effective_filing_date": ["effectivefilingdate"],
    "grant_date": ["grantdate"],
    "patent_number": ["patentnumber"],
    "publication_number": [
        "publicationsequencenumber",
        "publicationnumber"
    ],
    "status": [
        "applicationstatusdescriptiontext",
        "applicationstatus"
    ],
    "first_inventor": ["firstinventorname"],
    "first_applicant": ["firstapplicantname"],
    "art_unit": ["groupartunitnumber"],
    "application_type": ["applicationtypecategory"]
}

def session(api_key):
    s = requests.Session()
    s.headers.update({
        "X-API-KEY": api_key,
        "Accept": "application/json"
    })
    return s

def call_with_retries(func, *args, retries=3, delay=1, backoff=2, name="API call"):
    """
    Generic retry wrapper for API calls.

    Parameters:
        func: function to call
        *args: arguments for function
        retries: max attempts
        delay: initial delay (seconds)
        backoff: multiplier for exponential backoff
        name: label for logging
    """
    attempt = 0

    while attempt < retries:
        try:
            result = func(*args)

            # ✅ Optional: validate structure (very important for your case)
            if result is None or (isinstance(result, dict) and not result):
                raise ValueError("Empty response")

            return result

        except Exception as e:
            attempt += 1

            if attempt >= retries:
                print(f"[ERROR] {name} failed after {retries} attempts: {e}")
                return None

            wait = delay * (backoff ** (attempt - 1))
            print(f"[WARN] {name} failed (attempt {attempt}): {e} — retrying in {wait}s")
            time.sleep(wait)

def get_json(sess, url):
    r = sess.get(url, timeout=60)
    r.raise_for_status()
    return r.json()

def find_value(obj, keys):
    """
    Recursively search JSON for the first occurrence of any key in `keys`.
    """

    if obj is None:
        return None

    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() in keys:
                return v

            result = find_value(v, keys)
            if result is not None:
                return result

    elif isinstance(obj, list):
        for item in obj:
            result = find_value(item, keys)
            if result is not None:
                return result

    return None


def continuity(sess, app):
    return get_json(sess, f"{BASE}/{app}/continuity")


def foreign_priority(sess, app):
    return get_json(sess, f"{BASE}/{app}/foreign-priority")


def meta(sess, app):
    return get_json(sess, f"{BASE}/{app}/meta-data")


def extract_apps(obj):
    found = set()
    def walk(x):
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        else:
            for m in APP_RE.findall(str(x)):
                found.add(m)
    walk(obj)
    return found

def _find_values_for_key(obj, wanted_key_lower):
    """
    Recursively find all values where dict key matches wanted_key_lower (case-insensitive).
    Returns a list of values (could be list/dict).
    """
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() == wanted_key_lower:
                found.append(v)
            found.extend(_find_values_for_key(v, wanted_key_lower))
    elif isinstance(obj, list):
        for item in obj:
            found.extend(_find_values_for_key(item, wanted_key_lower))
    return found


# def _as_records(value):
    # """
    # Normalize unknown bag shapes into a list of dict records.
    # Handles:
      # - list[dict]
      # - dict containing a list somewhere
      # - single dict record
    # """
    # if value is None:
        # return []
    # if isinstance(value, list):
        # return [x for x in value if isinstance(x, dict)]
    # if isinstance(value, dict):
        # # sometimes the "bag" is a dict that contains the actual list
        # for v in value.values():
            # if isinstance(v, list):
                # return [x for x in v if isinstance(x, dict)]
        # return [value]
    # return []


# def extract_direct_continuity_edges(app_no, cont_json):
    # """
    # Extract ONLY direct parent-child edges for *this* app_no using ODP continuity bags.

    # According to USPTO docs, Continuity includes Parent and Child continuity "bags"
    # and fields like claimParentageTypeCode, parentApplicationNumberText, childApplicationNumberText. [1](https://github.com/ip-tools/python-epo-ops-client/)

    # For app A:
      # - parentContinuityBag record => parentApplicationNumberText -> A
      # - childContinuityBag record  => A -> childApplicationNumberText
    # """
    # app_no = str(app_no).strip()

    # # Find bags anywhere in the JSON (handles wrappers)
    # parent_bag_vals = _find_values_for_key(cont_json, "parentcontinuitybag")
    # child_bag_vals  = _find_values_for_key(cont_json, "childcontinuitybag")

    # parent_records = []
    # for v in parent_bag_vals:
        # parent_records.extend(_as_records(v))

    # child_records = []
    # for v in child_bag_vals:
        # child_records.extend(_as_records(v))

    # edges = set()

    # # Parent edges: parent -> app_no
    # for rec in parent_records:
        # parent = rec.get("parentApplicationNumberText") or rec.get("parentapplicationnumbertext")
        # rel = rec.get("claimParentageTypeCode") or rec.get("claimparentagetypecode") or "UNKNOWN"
        # if parent:
            # edges.add((str(parent).strip(), app_no, str(rel).strip().upper()))

    # # Child edges: app_no -> child
    # for rec in child_records:
        # child = rec.get("childApplicationNumberText") or rec.get("childapplicationnumbertext")
        # rel = rec.get("claimParentageTypeCode") or rec.get("claimparentagetypecode") or "UNKNOWN"
        # if child:
            # edges.add((app_no, str(child).strip(), str(rel).strip().upper()))

    # return edges

def _as_list(x):
    if x is None:
        return []
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        # handle wrapped lists if needed
        for v in x.values():
            if isinstance(v, list):
                return v
        return [x]
    return []


def extract_direct_continuity_edges(app_no, cont_json):
    """
    Extract only direct edges touching `app_no`.
    """
    app_no = str(app_no).strip()
    edges = set()

    # top-level wrapper in your sample:
    # patentFileWrapperDataBag -> [ { parentContinuityBag, childContinuityBag, applicationNumberText } ]
    bags = cont_json.get("patentFileWrapperDataBag", [])
    if isinstance(bags, dict):
        bags = [bags]

    for bag in bags:
        if not isinstance(bag, dict):
            continue

        # --- direct parents only ---
        for rec in _as_list(bag.get("parentContinuityBag")):
            parent = str(rec.get("parentApplicationNumberText", "")).strip()
            child = str(rec.get("childApplicationNumberText", "")).strip()
            rel = str(rec.get("claimParentageTypeCode", "UNKNOWN")).strip().upper()

            # KEEP ONLY if this record directly points to app_no
            if parent and child == app_no:
                edges.add((parent, app_no, rel))

        # --- direct children only ---
        # for rec in _as_list(bag.get("childContinuityBag")):
            # parent = str(rec.get("parentApplicationNumberText", "")).strip()
            # child = str(rec.get("childApplicationNumberText", "")).strip()
            # rel = str(rec.get("claimParentageTypeCode", "UNKNOWN")).strip().upper()

            # # KEEP ONLY if this record directly starts from app_no
            # if child and parent == app_no:
                # edges.add((app_no, child, rel))

    return edges

def _as_list(x):
    if x is None:
        return []
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        # handle wrapped list-like bags
        for v in x.values():
            if isinstance(v, list):
                return v
        return [x]
    return []


def extract_direct_parent_and_child_links(app_no, cont_json):
    """
    For queried app_no:
      - return direct parent edges to STORE in graph
      - return direct child app ids to TRAVERSE only

    parent edges stored as tuples: (parent_app, app_no, relation)
    child app ids returned as strings
    """
    app_no = str(app_no).strip()

    parent_edges = set()
    child_nodes = set()

    bags = cont_json.get("patentFileWrapperDataBag", [])
    if isinstance(bags, dict):
        bags = [bags]

    for bag in bags:
        if not isinstance(bag, dict):
            continue

        # ----------------------------
        # Direct parents only
        # ----------------------------
        for rec in _as_list(bag.get("parentContinuityBag")):
            parent = str(rec.get("parentApplicationNumberText", "")).strip()
            child = str(rec.get("childApplicationNumberText", "")).strip()
            rel = str(rec.get("claimParentageTypeCode", "UNKNOWN")).strip().upper()

            # Only keep direct parent -> current app
            if parent and child == app_no:
                parent_edges.add((parent, app_no, rel))

        # ----------------------------
        # Direct children only (for traversal)
        # ----------------------------
        for rec in _as_list(bag.get("childContinuityBag")):
            parent = str(rec.get("parentApplicationNumberText", "")).strip()
            child = str(rec.get("childApplicationNumberText", "")).strip()

            # Only keep direct children of current app
            if child and parent == app_no:
                child_nodes.add(child)

    return parent_edges, child_nodes


def extract_priority_nodes(fp_json):
    nodes = []
    def walk(x):
        if isinstance(x, dict):
            country = None
            number = None
            for k, v in x.items():
                lk = k.lower()
                if "country" in lk:
                    country = v
                if "number" in lk:
                    number = v
                walk(v)
            if country and number:
                nodes.append(f"PRIO:{country} {number}")
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(fp_json)
    return nodes

def extract_application_number(meta_json):
    return meta_json["patentFileWrapperDataBag"][0]["applicationNumberText"]

canonical_cache = {}

def canonicalize(sess, identifier):
    if identifier in canonical_cache:
        return canonical_cache[identifier]

    try:
        m = meta(sess, str(identifier))
        app = m.get("applicationNumberText")

        if app:
            canonical_cache[identifier] = str(app)
            return canonical_cache[identifier]
    except:
        pass

    canonical_cache[identifier] = str(identifier)
    return canonical_cache[identifier]


def normalize_app_id(x):
    """
    Normalize all identifiers into consistent canonical string form.
    """
    if x is None:
        return None

    # Convert to string
    x = str(x)

    # Remove whitespace
    x = x.strip()

    # Remove commas, spaces, etc if any
    x = x.replace(",", "")

    return x


def build_graph_old(sess, root_app: str, max_nodes: int = 60, include_foreign_priority: bool = True):
    G = nx.DiGraph()

    queue = [root_app]
    seen = set()

    while queue and len(seen) < max_nodes:
        app = queue.pop(0)
        if app in seen:
            continue

        seen.add(app)

        try:
            m = meta(sess, app)

            canonical = normalize_app_id(extract_application_number(m))
        
            if not canonical:
                canonical = app

            
            meta_struct = extract_node_metadata(m)

            node_id = normalize_app_id(meta_struct["application_number"] or canonical)

            if canonical not in G:
                G.add_node(canonical)
            
            # Update structured attributes
            for k, v in meta_struct.items():
                G.nodes[node_id][k] = v


        
        except Exception as e:
            print(f"An error occurred: {e}")
            node_id = app
            if node_id not in G:
                G.add_node(node_id, label=node_id)


        # continuity
        try:
            cont = continuity(sess, app)
            edges = extract_direct_continuity_edges(app, cont)
            
            m = call_with_retries(
                meta,
                sess,
                app,
                name=f"meta({app})"
            )


            # ✅ Save raw JSON for debugging
            debug_path = os.path.join(DEBUG_DIR, f"{app}_continuity.json")

            with open(debug_path, "w", encoding="utf-8") as f:
                json.dump(cont, f, indent=2)

            for u, v, rel in edges:

                # normalize endpoints
                u_id = canonicalize(sess, u)
                v_id = canonicalize(sess, v)
            
                G.add_edge(
                    u_id,
                    v_id,
                    type="continuity",
                    relation=rel
                )

                if u_id not in seen:
                    queue.append(u_id)
                if v_id not in seen:
                    queue.append(v_id)
        except:
            pass

        # foreign priority
        if include_foreign_priority:
            try:
                fp = foreign_priority(sess, app)
                prios = extract_priority_nodes(fp)
                  
                for p in prios:
                    G.add_node(p, label=p, type="priority")
                    G.add_edge(p, app, type="priority")

                    G.nodes[p].update({
                        "id": p,
                        "kind": "priority",
                        "priority_number": p,
                        "country": extract_priority_country(p),  # optional helper
                        "filing_date": extract_priority_date(p)
                    })

            except:
                pass

        time.sleep(0.2)

    return G

def build_graph(sess, root_app: str, max_nodes: int = 60, include_foreign_priority: bool = True):
    G = nx.DiGraph()

    queue = [normalize_app_id(root_app)]
    seen = set()

    while queue and len(seen) < max_nodes:
        app = normalize_app_id(queue.pop(0))
        if not app or app in seen:
            continue
        seen.add(app)

        # ----------------------------
        # Metadata hydration
        # ----------------------------
        try:
            
            m = call_with_retries(
                meta,
                sess,
                app,
                name=f"meta({app})"
            )

            meta_struct = extract_node_metadata(m)

            node_id = normalize_app_id(meta_struct.get("application_number") or app)
            G.add_node(node_id)
            for k, v in meta_struct.items():
                G.nodes[node_id][k] = v

        except Exception as e:
            node_id = app
            G.add_node(node_id)
            G.nodes[node_id]["application_number"] = app
            G.nodes[node_id]["kind"] = "application"
            G.nodes[node_id]["metadata_error"] = str(e)

        # ----------------------------
        # Continuity fetch + debug save
        # ----------------------------
        try:
                          
            cont = call_with_retries(
                continuity,
                sess,
                app,
                name=f"continuity({app})"
            )
            
            # Optional raw save for debugging
            debug_path = os.path.join(DEBUG_DIR, f"{app}_continuity.json")
            with open(debug_path, "w", encoding="utf-8") as f:
                json.dump(cont, f, indent=2)

            parent_edges, child_nodes = extract_direct_parent_and_child_links(app, cont)

            # ----------------------------
            # STORE ONLY PARENT EDGES
            # ----------------------------
            for u, v, rel in parent_edges:
                u_id = normalize_app_id(u)
                v_id = normalize_app_id(v)
                G.add_edge(u_id, v_id, type="continuity", relation=rel)

                # walk upward too
                if u_id not in seen:
                    queue.append(u_id)

            # ----------------------------
            # WALK CHILD NODES ONLY
            # ----------------------------
            for child in child_nodes:
                child_id = normalize_app_id(child)
                if child_id not in seen:
                    queue.append(child_id)

        except Exception as e:
            print(f"[WARN] continuity fetch failed for {app}: {e}")
            
        # foreign priority
        if include_foreign_priority:
            try:
                fp = foreign_priority(sess, app)
                prios = extract_priority_nodes(fp)
                  
                for p in prios:
                    G.add_node(p, label=p, type="priority")
                    G.add_edge(p, app, type="priority")

                    G.nodes[p].update({
                        "id": p,
                        "kind": "priority",
                        "priority_number": p,
                        "country": extract_priority_country(p),  # optional helper
                        "filing_date": extract_priority_date(p)
                    })

            except:
                pass

        time.sleep(0.2)
    return G


def save_graph(G, outdir):
    import os
    os.makedirs(outdir, exist_ok=True)

    nodes = []
    for n, data in G.nodes(data=True):
        record = {"id": n}
        record.update(data)
        nodes.append(record)

    edges = []
    for u, v, data in G.edges(data=True):
        record = {
            "source": u,
            "target": v
        }
        record.update(data)
        edges.append(record)

    pd.DataFrame(nodes).to_parquet(f"{outdir}/nodes.parquet")
    pd.DataFrame(nodes).to_excel(f"{outdir}/nodes.xlsx")
    pd.DataFrame(edges).to_parquet(f"{outdir}/edges.parquet")
    pd.DataFrame(edges).to_excel(f"{outdir}/edges.xlsx")

    print(f"Saved graph → {outdir}")


def find_root_app_from_patent(sess, patent_number: str):
    """
    Best-effort helper:
    Use /search to find an application number corresponding to a patent number.
    The ODP docs state the search endpoint can be used to search applications and
    return records, but field names vary; we try a few common ones.

    If none work, user should pass --app directly.
    """
    patent_number = re.sub(r"\D", "", patent_number)
    candidate_fields = [
        "applicationMetaData.patentNumberText",
        "applicationMetaData.patentNumber",
        "patentNumberText",
        "patentNumber",
    ]
    for f in candidate_fields:
        q = f"{f}:{patent_number}"
        try:
            data = odp_search(sess, q=q, limit=25, offset=0)
            # Extract any application numbers from the response; pick one deterministically.
            apps = sorted(find_app_numbers(data))
            if apps:
                return apps[0]
        except Exception:
            continue
    return None

def extract_node_metadata(meta_json):
    """
    Extract structured metadata from arbitrarily nested ODP JSON.
    """

    def get(field):
        keys = FIELD_MAP[field]
        return find_value(meta_json, keys)

    return {
        "application_number": get("application_number"),

        "filing_date": get("filing_date"),
        "effective_filing_date": get("effective_filing_date"),

        "grant_date": get("grant_date"),
        "patent_number": get("patent_number"),
        "publication_number": get("publication_number"),

        "status": get("status"),

        "first_inventor": get("first_inventor"),
        "first_applicant": get("first_applicant"),

        "art_unit": get("art_unit"),

        "application_type": get("application_type"),

        "kind": "application"
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", help="Root application number (8 digits), e.g., 16330077")
    ap.add_argument("--patent", help="Optional: root patent number (digits only or with commas)")
    ap.add_argument("--out", default=None, help="Output .pptx path")
    ap.add_argument("--max-nodes", type=int, default=200, help="Limit traversal size")
    ap.add_argument("--no-foreign-priority", action="store_true", help="Disable foreign priority nodes")
    args = ap.parse_args()

    api_key = USPTO_API_KEY
    if not api_key:
        raise ValueError("Set USPTO_API_KEY")

    root_app = args.app
    if not root_app and args.patent:
        root_app = find_root_app_from_patent(sess, args.patent)

    if not root_app or not APP_RE.fullmatch(root_app):
        raise SystemExit(
            "Could not determine root application number. Provide --app (8 digits). "
            "If using --patent, the heuristic search may have failed."
        )

    sess = session(api_key)
    G = build_graph(
        sess,
        root_app=root_app,
        max_nodes=args.max_nodes,
        include_foreign_priority=(not args.no_foreign_priority),
    )

    save_graph(G, os.path.join(DATA_DIR, f"graph_{root_app}"))


if __name__ == "__main__":
    main()
