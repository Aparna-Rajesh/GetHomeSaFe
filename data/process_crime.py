"""
GetHomeSaFe — Crime Data Pipeline
----------------------------------
Downloads SFPD incident data for a given year, snaps each incident to the
nearest street segment in downtown SF, aggregates by hour of day, and writes
a GeoJSON file ready for the web app.

Usage:
    python process_crime.py --year 2024

Output:
    ../public/streets_2024.geojson

Requirements:
    pip install osmnx geopandas pandas shapely requests tqdm
"""

import argparse
import json
import math
import os

import geopandas as gpd
import osmnx as ox
import pandas as pd
import requests
from shapely.geometry import Point
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Bounding box covering downtown SF: Tenderloin, SoMa, Mission, Civic Center
DOWNTOWN_BBOX = {
    "north": 37.7955,
    "south": 37.7690,
    "east":  -122.3900,
    "west":  -122.4250,
}

# SF Open Data — SFPD Incident Reports (2018–present)
# Socrata dataset ID: wg3w-h783
SF_CRIME_API = "https://data.sfgov.org/resource/wg3w-h783.csv"

# How many incidents to pull per API page (max 50000)
PAGE_SIZE = 50000

# Crime categories to include (pedestrian-relevant)
INCLUDED_CATEGORIES = {
    "ASSAULT",
    "ROBBERY",
    "BURGLARY",
    "DRUG OFFENSE",
    "DRUG/NARCOTIC",
    "DISORDERLY CONDUCT",
    "SUSPICIOUS OCC",
    "WEAPONS CARRYING ETC",
    "WEAPONS OFFENSE",
    "SEX OFFENSE",
    "PROSTITUTION",
    "LARCENY THEFT",
    "MOTOR VEHICLE THEFT",
}

# ---------------------------------------------------------------------------
# Step 1: Download crime data
# ---------------------------------------------------------------------------

def download_crime_data(year: int, raw_dir: str) -> pd.DataFrame:
    out_path = os.path.join(raw_dir, f"sfpd_{year}.csv")

    if os.path.exists(out_path):
        print(f"  Using cached {out_path}")
        return pd.read_csv(out_path)

    print(f"  Downloading SFPD data for {year} ...")
    frames = []
    offset = 0

    while True:
        params = {
            "$limit": PAGE_SIZE,
            "$offset": offset,
            "$where": (
                f"incident_year={year} AND "
                f"latitude > {DOWNTOWN_BBOX['south']} AND "
                f"latitude < {DOWNTOWN_BBOX['north']} AND "
                f"longitude > {DOWNTOWN_BBOX['west']} AND "
                f"longitude < {DOWNTOWN_BBOX['east']}"
            ),
            "$select": "incident_category,incident_date,incident_time,latitude,longitude",
        }
        resp = requests.get(SF_CRIME_API, params=params, timeout=60)
        resp.raise_for_status()
        batch = pd.read_csv(__import__("io").StringIO(resp.text))
        if batch.empty:
            break
        frames.append(batch)
        offset += PAGE_SIZE
        print(f"    fetched {offset} rows...")
        if len(batch) < PAGE_SIZE:
            break

    df = pd.concat(frames, ignore_index=True)
    df.to_csv(out_path, index=False)
    print(f"  Saved {len(df)} rows to {out_path}")
    return df


# ---------------------------------------------------------------------------
# Step 2: Clean and filter
# ---------------------------------------------------------------------------

def clean(df: pd.DataFrame) -> gpd.GeoDataFrame:
    df = df.copy()
    df = df.dropna(subset=["latitude", "longitude", "incident_time"])
    df["latitude"] = pd.to_numeric(df["latitude"], errors="coerce")
    df["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
    df = df.dropna(subset=["latitude", "longitude"])

    # Filter to relevant crime categories
    df["incident_category"] = df["incident_category"].str.upper().str.strip()
    df = df[df["incident_category"].isin(INCLUDED_CATEGORIES)]

    # Extract hour (incident_time is "HH:MM" string)
    df["hour"] = df["incident_time"].str[:2].astype(int, errors="ignore")
    df = df[df["hour"].between(0, 23)]

    gdf = gpd.GeoDataFrame(
        df,
        geometry=gpd.points_from_xy(df["longitude"], df["latitude"]),
        crs="EPSG:4326",
    )
    print(f"  {len(gdf)} incidents after cleaning/filtering")
    return gdf


# ---------------------------------------------------------------------------
# Step 3: Download street network
# ---------------------------------------------------------------------------

def get_street_network() -> gpd.GeoDataFrame:
    print("  Fetching street network from OpenStreetMap ...")
    bbox = (
        DOWNTOWN_BBOX["north"],
        DOWNTOWN_BBOX["south"],
        DOWNTOWN_BBOX["east"],
        DOWNTOWN_BBOX["west"],
    )
    G = ox.graph_from_bbox(*bbox, network_type="walk")
    edges = ox.graph_to_gdfs(G, nodes=False, edges=True)
    edges = edges.reset_index()
    edges = edges.to_crs("EPSG:3857")  # project to metres for snapping
    print(f"  {len(edges)} street segments loaded")
    return edges


# ---------------------------------------------------------------------------
# Step 4: Snap incidents to nearest street segment
# ---------------------------------------------------------------------------

def snap_to_streets(incidents: gpd.GeoDataFrame, streets: gpd.GeoDataFrame) -> pd.DataFrame:
    print("  Snapping incidents to nearest street segment ...")
    incidents_proj = incidents.to_crs("EPSG:3857")

    # Build a spatial index for fast nearest-neighbour lookup
    streets_sindex = streets.sindex

    results = []
    for idx, row in tqdm(incidents_proj.iterrows(), total=len(incidents_proj)):
        point = row.geometry
        # Candidate segments within 100 m
        candidates = list(streets_sindex.nearest(point, 5))
        best = min(candidates, key=lambda i: streets.iloc[i].geometry.distance(point))
        results.append({
            "segment_idx": best,
            "hour": row["hour"],
        })

    return pd.DataFrame(results)


# ---------------------------------------------------------------------------
# Step 5: Aggregate counts per segment per hour
# ---------------------------------------------------------------------------

def aggregate(snapped: pd.DataFrame, streets: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    print("  Aggregating counts by segment and hour ...")

    # Count incidents per (segment, hour)
    counts = snapped.groupby(["segment_idx", "hour"]).size().reset_index(name="count")

    # Pivot to one row per segment with 24 hourly columns
    pivot = counts.pivot(index="segment_idx", columns="hour", values="count").fillna(0)
    # Ensure all 24 hours present
    for h in range(24):
        if h not in pivot.columns:
            pivot[h] = 0
    pivot = pivot[[h for h in range(24)]]

    streets_out = streets.copy().to_crs("EPSG:4326")
    streets_out["counts"] = None

    for seg_idx, row in pivot.iterrows():
        streets_out.at[seg_idx, "counts"] = row.tolist()

    # Keep only segments that have at least one incident; fill rest with zeros
    streets_out["counts"] = streets_out["counts"].apply(
        lambda x: x if isinstance(x, list) else [0] * 24
    )

    # Keep useful columns only
    keep = ["name", "geometry", "counts"]
    available = [c for c in keep if c in streets_out.columns]
    streets_out = streets_out[available]

    return streets_out


# ---------------------------------------------------------------------------
# Step 6: Write GeoJSON
# ---------------------------------------------------------------------------

def write_geojson(gdf: gpd.GeoDataFrame, year: int, output_dir: str):
    out_path = os.path.join(output_dir, f"streets_{year}.geojson")
    gdf.to_file(out_path, driver="GeoJSON")
    size_mb = os.path.getsize(out_path) / 1_000_000
    print(f"  Written to {out_path} ({size_mb:.1f} MB)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="GetHomeSaFe data pipeline")
    parser.add_argument("--year", type=int, required=True, help="Year of crime data (e.g. 2024)")
    args = parser.parse_args()

    raw_dir = os.path.join(os.path.dirname(__file__), "raw")
    output_dir = os.path.join(os.path.dirname(__file__), "..", "public")
    os.makedirs(raw_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    print(f"\n=== GetHomeSaFe Pipeline: {args.year} ===\n")

    print("[1/5] Downloading crime data...")
    df = download_crime_data(args.year, raw_dir)

    print("[2/5] Cleaning and filtering...")
    incidents = clean(df)

    print("[3/5] Loading street network...")
    streets = get_street_network()

    print("[4/5] Snapping to streets...")
    snapped = snap_to_streets(incidents, streets)

    print("[5/5] Aggregating and writing output...")
    result = aggregate(snapped, streets)
    write_geojson(result, args.year, output_dir)

    print("\nDone.")


if __name__ == "__main__":
    main()
