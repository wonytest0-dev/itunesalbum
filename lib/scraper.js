const axios = require("axios");
const cheerio = require("cheerio");
const COUNTRIES = require("./countries.json");

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseRowsFromTables($, countryName) {
  const rows = [];

  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");

    if (tds.length < 2) return;

    let rankText = "";
    let movement = "";
    let fullText = "";

    if (tds.length >= 3) {
      rankText = $(tds[0]).text().trim();
      movement = $(tds[1]).text().trim();
      fullText = $(tds[2]).text().replace(/\s+/g, " ").trim();
    } else if (tds.length === 2) {
      rankText = $(tds[0]).text().trim();
      fullText = $(tds[1]).text().replace(/\s+/g, " ").trim();
    }

    if (!/^\d+$/.test(rankText) || !fullText) return;

    let artist = fullText;
    let title = "";

    const separatorIndex = fullText.indexOf(" - ");
    if (separatorIndex !== -1) {
      artist = fullText.slice(0, separatorIndex).trim();
      title = fullText.slice(separatorIndex + 3).trim();
    }

    rows.push({
      rank: Number(rankText),
      movement,
      artist,
      title,
      fullText
    });
  });

  console.log(`\n[DEBUG] ${countryName}`);
  console.log(`Rows parsed: ${rows.length}`);

  if (rows.length > 0) {
    console.log("Top 3:");
    rows.slice(0, 3).forEach((row) => {
      console.log(`#${row.rank} ${row.fullText}`);
    });
  } else {
    console.log("NO ROWS PARSED");
  }

  return rows;
}

function parseRowsFromText($, countryName) {
  const rawText = $("body").text().replace(/\r/g, "");
  const lines = rawText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const rows = [];
  const startIndex = lines.findIndex((line) => {
    const normalized = normalize(line);
    return (
      normalized.includes("pos artist - title") ||
      normalized.includes("pos p+ artist - title")
    );
  });

  if (startIndex === -1) {
    console.log(`\n[FALLBACK TEXT] ${countryName}`);
    console.log("Header not found in page text");
    return rows;
  }

  let i = startIndex + 1;

  while (i < lines.length) {
    const current = lines[i];

    if (!/^\d+$/.test(current)) {
      i += 1;
      continue;
    }

    const rank = Number(current);
    let fullText = "";
    let movement = "";

    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];

      if (/^\d+$/.test(next)) {
        break;
      }

      if (!fullText && next && !/^[-+→↔*]+$/.test(next)) {
        fullText = next;
      } else if (!movement && /^[-+→↔*0-9]+$/.test(next)) {
        movement = next;
      }

      j += 1;
    }

    if (!fullText) {
      i = j;
      continue;
    }

    let artist = fullText;
    let title = "";

    const separatorIndex = fullText.indexOf(" - ");
    if (separatorIndex !== -1) {
      artist = fullText.slice(0, separatorIndex).trim();
      title = fullText.slice(separatorIndex + 3).trim();
    }

    rows.push({
      rank,
      movement,
      artist,
      title,
      fullText
    });

    i = j;
  }

  console.log(`\n[FALLBACK TEXT] ${countryName}`);
  console.log(`Rows parsed: ${rows.length}`);

  if (rows.length > 0) {
    console.log("Top 3:");
    rows.slice(0, 3).forEach((row) => {
      console.log(`#${row.rank} ${row.fullText}`);
    });
  } else {
    console.log("NO ROWS PARSED");
  }

  return rows;
}

async function fetchCountryChart(country) {
  const { slug, name, special } = country;

  try {
    const url = special
      ? "https://kworb.net/ww/"
      : `https://kworb.net/charts/aitunes/${slug}.html`;

    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      },
      timeout: 20000,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304
    });

    if (response.status === 304) {
      return {
        countrySlug: slug,
        countryName: name,
        success: false,
        rows: [],
        error: "304 Not Modified"
      };
    }

    const $ = cheerio.load(response.data);

    let rows = parseRowsFromTables($, name);

    if (!rows.length) {
      rows = parseRowsFromText($, name);
    }

    return {
      countrySlug: slug,
      countryName: name,
      success: true,
      rows
    };
  } catch (error) {
    return {
      countrySlug: slug,
      countryName: name,
      success: false,
      rows: [],
      error: error.message
    };
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;

  async function runner() {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= items.length) break;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runner()
  );

  await Promise.all(workers);
  return results;
}

async function fetchAllCountries(concurrency = 10) {
  return runWithConcurrency(COUNTRIES, concurrency, async (country) => {
    return fetchCountryChart(country);
  });
}

function matchQuery(item, keyword, exact) {
  const artist = normalize(item.artist);
  const title = normalize(item.title);
  const fullText = normalize(item.fullText);
  const key = normalize(keyword);

  if (exact) {
    return artist === key || title === key || fullText === key;
  }

  return (
    artist.includes(key) ||
    title.includes(key) ||
    fullText.includes(key) ||
    key.includes(artist) ||
    key.includes(title)
  );
}

function findChartRanksCustom(allChartData, query, options = {}) {
  const {
    exact = false,
    firstOnly = true,
    extendedTopRegions = new Set(),
    defaultTopLimit = 1,
    extendedTopLimit = 100
  } = options;

  const keyword = normalize(query);
  const found = [];

  for (const country of allChartData) {
    if (!country.success) continue;

    const limit = extendedTopRegions.has(country.countryName)
      ? extendedTopLimit
      : defaultTopLimit;

    const filteredRows = country.rows.filter((item) => item.rank <= limit);
    const matches = filteredRows.filter((item) => matchQuery(item, keyword, exact));

    if (!matches.length) continue;

    if (firstOnly) {
      const best = matches[0];
      found.push({
        countryName: country.countryName,
        countrySlug: country.countrySlug,
        rank: best.rank,
        artist: best.artist,
        title: best.title,
        fullText: best.fullText
      });
    } else {
      for (const match of matches) {
        found.push({
          countryName: country.countryName,
          countrySlug: country.countrySlug,
          rank: match.rank,
          artist: match.artist,
          title: match.title,
          fullText: match.fullText
        });
      }
    }
  }

  return found.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.countryName.localeCompare(b.countryName);
  });
}

module.exports = {
  fetchCountryChart,
  fetchAllCountries,
  findChartRanksCustom
};