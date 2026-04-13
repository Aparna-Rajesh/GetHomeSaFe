# GetHomeSaFe

I've been considering moving to San Francisco for some time now, and while comparing its neighborhoods with those of Manhattan, folks familiar with SF have all responded with some version of the same thing: *"oh, just avoid [street] after [time]."*

Which is great advice! But after a handful of these conversations, I found myself attempting to maintain a mental list of street names, hours, and vague disclaimers that I could no longer keep straight.

So I'm building a map using existing crime data sets & the warnings I've received from friends, Uber drivers, realtors, and the like.

---

**GetHomeSaFe** is an interactive street-level safety map of San Francisco that layers two things on top of each other:

- **Official crime data** from the [SF Police Department Incident Reports](https://data.sfgov.org/resource/wg3w-h783) — broken down by individual street segment and hour of day, so you can see *when* and *where* incidents actually tend to occur
- **Hearsay** — a community-curated layer of the kind of anecdotal tips that don't show up in any database but are nonetheless very real local knowledge (see: every SF transplant I've ever spoken to)

You can scrub through all 24 hours of the day to see how the picture changes, or just open it when you need it, and it'll already be set to the current time.

**A note:** this is a data visualization, not a verdict on any neighborhood. The crime data reflects reported incidents in public SFPD records & it says nothing about the character of a place or the people who live there. Cities are complicated, and any block can look different at 2 PM versus 2 AM.

---

## Running it locally

```bash
# Install Python dependencies (one time)
pip install osmnx geopandas pandas shapely requests

# Process crime data for a given year
python data/process_crime.py --year 2024

# Serve the app
python3 -m http.server 8765
# Open http://localhost:8765
```

## Adding hearsay

Edit `public/hearsay.json`. The format is straightforward:

```json
{
  "street": "6th Street",
  "from": "Market St",
  "to": "Howard St",
  "hours": [23, 0, 1, 2],
  "note": "Avoid around midnight — via @mmaaz_98 on X"
}
```

`hours` is an array of hours (0 = midnight, 23 = 11 PM) during which the warning applies.

## Data sources

- SFPD Incident Reports: [data.sfgov.org](https://data.sfgov.org/resource/wg3w-h783)
- Street network: [OpenStreetMap](https://www.openstreetmap.org) via [OSMnx](https://github.com/gboeing/osmnx)
- Map tiles: [CartoDB](https://carto.com/attributions)
