import express from "express";
import * as cheerio from "cheerio";
import vm from "node:vm";

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "https://www.meandqi.com";
const API_KEY = process.env.API_KEY;

app.use(express.json());

function requireApiKey(req, res, next) {
  const provided = req.header("x-api-key");

  if (!API_KEY) {
    return res.status(500).json({ message: "API_KEY não configurada no servidor" });
  }

  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ message: "API key ausente ou inválida" });
  }

  next();
}

app.use(requireApiKey);

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function slugFromUrl(url) {
  return url.split("/").filter(Boolean).pop() || "";
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MeAndQiProxy/1.0)"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Falha ao acessar ${url}: ${response.status}`);
  }

  return await response.text();
}

function extractAllPatternsFromHtml(html) {
  const match = html.match(/window\.allPatterns\s*=\s*(\[[\s\S]*?\]);/);

  if (!match) {
    throw new Error("Não foi possível localizar window.allPatterns na página");
  }

  const jsArrayLiteral = match[1];

  let parsed;
  try {
    parsed = vm.runInNewContext(`(${jsArrayLiteral})`, {}, { timeout: 1000 });
  } catch (error) {
    throw new Error(`Falha ao interpretar window.allPatterns: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("window.allPatterns não resultou em um array");
  }

  return parsed.map((item) => {
    const relativeUrl = String(item.url || "");
    const absoluteUrl = relativeUrl.startsWith("http")
      ? relativeUrl
      : `${BASE_URL}${relativeUrl}`;

    return {
      slug: slugFromUrl(relativeUrl),
      title: String(item.name || ""),
      pinyinName: String(item.pinyinName || ""),
      chineseName: String(item.chineseName || ""),
      nature: String(item.nature || ""),
      organs: Array.isArray(item.organs) ? item.organs.map(String) : [],
      byVitalSubstance: Array.isArray(item.byVitalSubstance) ? item.byVitalSubstance.map(String) : [],
      byPathogenicFactor: Array.isArray(item.byPathogenicFactor) ? item.byPathogenicFactor.map(String) : [],
      mainSymptoms: Array.isArray(item.mainSymptoms) ? item.mainSymptoms.map(String) : [],
      allSymptoms: Array.isArray(item.allSymptoms) ? item.allSymptoms.map(String) : [],
      isGeneralPattern: Boolean(item.isGeneralPattern),
      url: absoluteUrl
    };
  });
}

async function scrapePatternsIndex() {
  const html = await fetchHtml(`${BASE_URL}/knowledge-base/patterns`);
  return extractAllPatternsFromHtml(html);
}

async function scrapePatternDetail(slug) {
  const url = `${BASE_URL}/knowledge-base/patterns/${slug}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const indexItems = await scrapePatternsIndex();
  const summary = indexItems.find((item) => item.slug === slug);

  const title =
    normalizeWhitespace($("h1").first().text()) ||
    summary?.title ||
    normalizeWhitespace($("title").first().text()) ||
    slug;

  const paragraphs = [];
  $("p").each((_, el) => {
    const text = normalizeWhitespace($(el).text());
    if (text) paragraphs.push(text);
  });

  const sections = [];
  $("h2, h3").each((_, el) => {
    const heading = normalizeWhitespace($(el).text());
    if (!heading) return;

    const bodyParts = [];
    let next = $(el).next();

    while (next.length && !["h2", "h3"].includes(next[0].tagName)) {
      const text = normalizeWhitespace(next.text());
      if (text) bodyParts.push(text);
      next = next.next();
    }

    sections.push({
      heading,
      body: bodyParts.join("\n\n")
    });
  });

  return {
    slug,
    title,
    pinyinName: summary?.pinyinName || "",
    chineseName: summary?.chineseName || "",
    nature: summary?.nature || "",
    organs: summary?.organs || [],
    byVitalSubstance: summary?.byVitalSubstance || [],
    byPathogenicFactor: summary?.byPathogenicFactor || [],
    mainSymptoms: summary?.mainSymptoms || [],
    allSymptoms: summary?.allSymptoms || [],
    isGeneralPattern: summary?.isGeneralPattern || false,
    url: summary?.url || url,
    content: paragraphs.join("\n\n"),
    sections
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "meandqi-patterns-proxy",
    source: "window.allPatterns"
  });
});

app.get("/patterns", async (req, res) => {
  try {
    const q = normalizeWhitespace(req.query.q || "").toLowerCase();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);

    let items = await scrapePatternsIndex();

    if (q) {
      items = items.filter((item) =>
        item.title.toLowerCase().includes(q) ||
        item.slug.toLowerCase().includes(q) ||
        item.pinyinName.toLowerCase().includes(q) ||
        item.chineseName.toLowerCase().includes(q) ||
        item.organs.some((x) => x.toLowerCase().includes(q)) ||
        item.byVitalSubstance.some((x) => x.toLowerCase().includes(q)) ||
        item.byPathogenicFactor.some((x) => x.toLowerCase().includes(q)) ||
        item.mainSymptoms.some((x) => x.toLowerCase().includes(q)) ||
        item.allSymptoms.some((x) => x.toLowerCase().includes(q))
      );
    }

    const total = items.length;
    const start = (page - 1) * limit;

    res.json({
      page,
      limit,
      total,
      items: items.slice(start, start + limit)
    });
  } catch (error) {
    res.status(500).json({
      message: error.message || "Falha ao listar padrões"
    });
  }
});

app.get("/patterns/:slug", async (req, res) => {
  try {
    const detail = await scrapePatternDetail(req.params.slug);
    res.json(detail);
  } catch (error) {
    res.status(404).json({
      message: error.message || "Padrão não encontrado"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
