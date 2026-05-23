#!/usr/bin/env python3

#graphviz workaround
import os
os.environ["PATH"] += os.pathsep + r'C:\Users\30712\OneDrive - WilmerHale\Client Matters\_Code\Graphviz\bin'

import pandas as pd
from graphviz import Digraph
from pathlib import Path
import argparse
from datetime import datetime
from IPython.display import Image, display


# ---------------------------
# Utilities
# ---------------------------

def parse_date(s):
    if not s or pd.isna(s):
        return None
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(str(s), fmt).date()
        except:
            pass
    return None


def extract_filing_date(attrs):
    for k in ["filingDate", "effectiveFilingDate"]:
        if k in attrs:
            d = parse_date(attrs[k])
            if d:
                return d

    # fallback: try raw_meta if present
    if "raw_meta" in attrs:
        meta = attrs["raw_meta"]
        if isinstance(meta, dict):
            if "filingDate" in meta:
                return parse_date(meta["filingDate"])
    return None


def bucket_date(d):
    if not d:
        return "Unknown"
    return f"{d.year}-{d.month:02d}"


# ---------------------------
# Node styling (same as prior)
# ---------------------------

def node_style(node_id, attrs):
    is_prio = str(node_id).startswith("PRIO:")

    style = {
        "style": "rounded,filled",
        "fillcolor": "#EEFFEF",
        "fontname": "Helvetica",
        "fontsize": "10"
    }

    if is_prio:
        style["shape"] = "note"
        style["fillcolor"] = "#D6ECFF"

    return style

def node_visual_style(attrs):
    app_type = classify_application_type(attrs)
    status = classify_status(attrs)

    # --- base fill color (application type) ---
    fill_map = {
        "PROVSNL": "#FFF7CC",        # light yellow
        "REGULAR": "#E3F2FD",        # light blue
        "REEXAM":  "#CEFAD0",        # light green
        "FOREIGN": "#F3E5F5"         # light purple
    }

    # --- border color (status) ---
    border_map = {
        "issued": "#2E7D32",     # green
        "pending": "#EF6C00",    # orange
        "active": "#1565C0",     # blue
        "expired": "#C62828",    # red
        "unknown": "#616161"     # gray
    }

    return {
        "fillcolor": fill_map.get(app_type, "#EEEEEE"),
        "color": border_map.get(status, "#616161"),
        "penwidth": "0" #if status in ("issued", "pending", "expired") else "1.2"
    }


def wrap_text(text, width=30):
    words = str(text).split()
    lines = []
    current = []

    for w in words:
        if sum(len(x) for x in current) + len(current) + len(w) > width:
            lines.append(" ".join(current))
            current = [w]
        else:
            current.append(w)

    if current:
        lines.append(" ".join(current))

    return "<BR/>".join(lines)

def build_node_label2(node_id, attrs):

    fillcolor = node_visual_style(attrs)["fillcolor"]
    statuscolor = node_visual_style(attrs)["color"]

    def row(label, value):
        return f"""
        <TR>
            <TD ALIGN="LEFT"><B>{label}</B></TD>
            <TD ALIGN="LEFT">{value}</TD>
        </TR>
        """

    html = f"""<<TABLE BORDER="2" CELLBORDER="0" CELLPADDING="3" BGCOLOR="{fillcolor}">"""

    html += f"""
    <TR>
        <TD COLSPAN="2" ALIGN="CENTER">
            <FONT POINT-SIZE="11"><B>{node_id}</B></FONT>
        </TD>
    </TR>
    """

    html += """
    <HR/>
    """

    if attrs.get("filing_date"):
        html += row("Filed", attrs["filing_date"])

    if attrs.get("grant_date"):
        html += row("Grant", attrs["grant_date"])

    if attrs.get("patent_number"):
        html += row("Patent", attrs["patent_number"])
    elif attrs.get("publication_number"):
        html += row("Publication", attrs["publication_number"])

    if attrs.get("status"):
        html += row("Status", wrap_text(attrs["status"], 35))

    html += "</TABLE>>"

    return html

# ---------------------------
# NEW: Edge styling by relation
# ---------------------------

def edge_style(attrs):
    rel = str(attrs.get("relation", "")).upper()
    
    if rel == "CON":
        return {"color": "black", "style": "solid", "xlabel": "CON"}

    elif rel == "CIP":
        return {"color": "#E65100", "style": "dashed", "xlabel": "CIP"}

    elif rel == "DIV":
        return {"color": "#1565C0", "penwidth": "2", "xlabel": "DIV"}

    elif rel == "PRO":
        return {"color": "#2E7D32", "style": "dashed", "xlabel": "PRO"}

    elif rel == "REX":
        return {"color": "blue", "style": "dashed", "xlabel": "REX"}

    else:
        return {"color": "gray", "style": "solid"}


# ---------------------------
# Main Graphviz builder
# ---------------------------

def build_graph(nodes_df, edges_df, title):

    dot = Digraph("family_tree", format="png")

    dot.attr(
        rankdir="LR",  # left → right chronology (change to TB for top -> bottom)
        splines="spline",  #try ortho, polyline, or spline for different aesthetics
        fontname="Helvetica",
        nodesep="1.2",  # Horizontal spacing
        ranksep="1.5",  # vertical spacing
        label=title,
        labelloc="t",
        #edge={"minlen": "2"}  # stretch edges
    )

    # Build node attribute dict
    node_attrs = {}
    for _, row in nodes_df.iterrows():
        nid = str(row["id"])
        node_attrs[nid] = dict(row)

    # Assign time buckets
    bucket_map = {}

    for nid, attrs in node_attrs.items():
        if str(nid).startswith("PRIO:"):
            d = None
        else:
            d = extract_filing_date(attrs)

        bucket_map[nid] = bucket_date(d)

    # Sort buckets
    buckets = sorted(bucket_map.values())

    # Add nodes grouped by date
    for b in buckets:
        with dot.subgraph() as sg:
            sg.attr(rank="same")

            nodes = [n for n in node_attrs if bucket_map[n] == b]

            for nid in sorted(nodes):
                attrs = node_attrs[nid]
                style = node_style(nid, attrs)

                label = build_node_label2(nid, attrs)
                style = node_visual_style(attrs)

                dot.node(
                    nid,
                    label=label,
                    shape="rect",
                    fontname="Helvetica",
                    **style
                )

    # Add edges (NEW behavior)
    for _, row in edges_df.iterrows():
        u = str(row["source"])
        v = str(row["target"])

        attrs = dict(row)
        estyle = edge_style(attrs)

        dot.edge(u, v, **estyle)

    #add_legend(dot)
    return dot

def add_legend(dot):

    legend = r"""<
    <TABLE BORDER="1" CELLBORDER="0" CELLPADDING="4">

    <TR><TD COLSPAN="2"><B>Node Colors</B></TD></TR>
    <TR><TD BGCOLOR="#FFF7CC"></TD><TD>Provisional</TD></TR>
    <TR><TD BGCOLOR="#E3F2FD"></TD><TD>Non-Provisional</TD></TR>
    <TR><TD BGCOLOR="#F3E5F5"></TD><TD>Foreign</TD></TR>

    <TR><TD COLSPAN="2"><B>Status (Border)</B></TD></TR>
    <TR><TD><FONT COLOR="#2E7D32"><B>■</B></FONT></TD><TD>Issued / Granted</TD></TR>
    <TR><TD><FONT COLOR="#EF6C00"><B>■</B></FONT></TD><TD>Pending</TD></TR>
    <TR><TD><FONT COLOR="#1565C0"><B>■</B></FONT></TD><TD>Active</TD></TR>
    <TR><TD><FONT COLOR="#C62828"><B>■</B></FONT></TD><TD>Expired / Abandoned</TD></TR>

    <TR><TD COLSPAN="2"><B>Edge Types</B></TD></TR>
    <TR><TD>──</TD><TD>Continuation (CON)</TD></TR>
    <TR><TD>−−−</TD><TD>CIP</TD></TR>
    <TR><TD><B>━━</B></TD><TD>Divisional</TD></TR>
    <TR><TD>····</TD><TD>Provisional (PRO)</TD></TR>

    </TABLE>
    >"""

    dot.node("legend", shape="plain", label=legend)


def classify_application_type(attrs):
    """
    Determine application type.
    """
    app_type = str(attrs.get("application_type", "") or "")
    return app_type


def classify_status(attrs):
    """
    Normalize status into buckets.
    """
    status = str(attrs.get("status") or "").lower()

    if "abandon" in status or "expire" in status:
        return "expired"

    if "patented" in status:
        return "active"

    return "pending"

# ---------------------------
# Main
# ---------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="graph directory")
    args = ap.parse_args()

    path = Path(args.path)

    nodes = pd.read_parquet(path / "nodes.parquet")
    edges = pd.read_parquet(path / "edges.parquet")

    dot = build_graph(nodes, edges, title=f"Family Tree – {path.name}")

    out = path / "family_tree"

    output_path = dot.render(str(out), cleanup=True)

    print(f"Saved: {output_path}")

    # --- NEW: display inline in IPython ---
    try:
        display(Image(filename=output_path))
    except Exception:
        # Fallback if not in IPython
        pass



if __name__ == "__main__":
    main()
