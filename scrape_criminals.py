"""
scrape_criminals.py
-------------------
Scrapes Wikipedia's "List of serial killers by country" and produces
criminals.json with ~50 entries, one per country where possible.

Usage:
    pip install requests beautifulsoup4
    python scrape_criminals.py
"""

import json
import re
import time
import random
import requests
from bs4 import BeautifulSoup

WIKI_BASE = "https://en.wikipedia.org"
LIST_URL  = f"{WIKI_BASE}/wiki/List_of_serial_killers_by_country"
HEADERS   = {"User-Agent": "CriminalOfTheDay/1.0 (educational scraper)"}

TARGET    = 50   # how many criminals to collect
SLEEP     = 0.8  # seconds between requests — be polite to Wikipedia

# Countries to skip (too many already covered or too sensitive)
SKIP_COUNTRIES = {"Nazi Germany", "Soviet Union"}

# ── helpers ──────────────────────────────────────────────────────────────────

def get_soup(url):
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return BeautifulSoup(r.text, "html.parser")

def clean(text):
    return re.sub(r'\s+', ' ', text).strip()

def parse_years(text):
    """Extract year range like '1978–1991' or single year '1969'."""
    m = re.search(r'(\d{4})\s*[–\-]\s*(\d{4})', text)
    if m:
        return f"{m.group(1)}–{m.group(2)}"
    m = re.search(r'(\d{4})', text)
    return m.group(1) if m else "Unknown"

def parse_victims(text):
    """Extract victim count like '30+' or '4–11'."""
    m = re.search(r'(\d+)\s*[–\-\+]?\s*(\d+)?', text)
    if not m:
        return "Unknown"
    if m.group(2):
        return f"{m.group(1)}–{m.group(2)}"
    suffix = "+" if "+" in text or "least" in text.lower() else ""
    return f"{m.group(1)}{suffix}"

def fetch_wiki_summary(wiki_url):
    """Get intro paragraph from a killer's Wikipedia page."""
    try:
        time.sleep(SLEEP)
        soup = get_soup(wiki_url)
        content = soup.find('div', {'class': 'mw-parser-output'})
        if not content:
            return ""
        for p in content.find_all('p'):
            text = clean(p.get_text())
            if len(text) > 80 and not text.startswith("^"):
                return text
    except Exception as e:
        print(f"    Warning: could not fetch {wiki_url}: {e}")
    return ""

# ── main scraper ──────────────────────────────────────────────────────────────

def scrape():
    print(f"Fetching {LIST_URL} ...")
    soup = get_soup(LIST_URL)
    content = soup.find('div', {'class': 'mw-parser-output'})

    criminals = []
    seen_countries = set()
    current_country = "Unknown"

    elements = content.find_all(['h2', 'h3', 'table'])

    for el in elements:
        if len(criminals) >= TARGET:
            break

        # Track current country from headings
        if el.name in ('h2', 'h3'):
            heading_text = clean(el.get_text())
            heading_text = re.sub(r'\[.*?\]', '', heading_text).strip()
            if heading_text not in ('Contents', 'References', 'See also',
                                    'External links', 'Notes', 'Further reading'):
                current_country = heading_text
            continue

        # Parse tables
        if el.name != 'table':
            continue
        if current_country in SKIP_COUNTRIES:
            continue

        rows = el.find_all('tr')
        for row in rows[1:]:  # skip header row
            if len(criminals) >= TARGET:
                break

            cells = row.find_all(['td', 'th'])
            if len(cells) < 2:
                continue

            # Extract name + Wikipedia link
            name_cell = cells[0]
            name_link = name_cell.find('a')
            name = clean(name_cell.get_text())
            name = re.sub(r'\[.*?\]', '', name).strip()
            if not name or len(name) < 2:
                continue

            wiki_url = ""
            if name_link and name_link.get('href', '').startswith('/wiki/'):
                wiki_url = WIKI_BASE + name_link['href']

            # Extract alias if present (often in parentheses or second cell)
            alias = ""
            alias_match = re.search(r'"([^"]+)"', name)
            if alias_match:
                alias = alias_match.group(1)
                name  = name.replace(f'"{alias}"', '').strip().strip(',').strip()

            # Try to get years, victims from other cells
            all_text = " ".join(c.get_text() for c in cells)
            period   = parse_years(all_text)
            victims  = parse_victims(cells[1].get_text() if len(cells) > 1 else "")

            # Skip if already have this country (one per country for variety)
            # But allow up to 2 per major countries
            country_count = sum(1 for c in criminals if c['country'] == current_country)
            if country_count >= 1 and current_country not in ('USA', 'United States', 'Russia'):
                continue

            # Fetch Wikipedia intro for context
            wiki_summary = ""
            if wiki_url:
                print(f"  [{len(criminals)+1}/{TARGET}] {name} ({current_country}) — fetching wiki...")
                wiki_summary = fetch_wiki_summary(wiki_url)
                time.sleep(SLEEP)
            else:
                print(f"  [{len(criminals)+1}/{TARGET}] {name} ({current_country}) — no wiki link")

            slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')

            criminal = {
                "day": len(criminals) + 1,
                "slug": slug,
                "name": name,
                "alias": alias,
                "country": current_country,
                "period": period,
                "victims": victims,
                "sentence": "",
                "tags": [current_country, period[:4] + "s" if period[:4].isdigit() else ""],
                "wiki_url": wiki_url,
                "wiki_summary": wiki_summary
            }
            criminals.append(criminal)

    # Shuffle slightly so countries are mixed (keep day order intact after)
    # Group by country then interleave
    from itertools import zip_longest
    by_country = {}
    for c in criminals:
        by_country.setdefault(c['country'], []).append(c)

    interleaved = []
    lists = list(by_country.values())
    random.shuffle(lists)
    for group in zip_longest(*lists):
        for item in group:
            if item:
                interleaved.append(item)

    # Re-assign day numbers
    for i, c in enumerate(interleaved):
        c['day'] = i + 1

    return interleaved

# ── run ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    criminals = scrape()

    with open('criminals.json', 'w', encoding='utf-8') as f:
        json.dump(criminals, f, ensure_ascii=False, indent=2)

    print(f"\nDone. Saved {len(criminals)} criminals to criminals.json")
    print("\nCountries covered:")
    countries = sorted(set(c['country'] for c in criminals))
    for country in countries:
        count = sum(1 for c in criminals if c['country'] == country)
        print(f"  {country}: {count}")
