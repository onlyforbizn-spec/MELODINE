const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir() });
const anyFile = upload.any();
app.use(express.json({ limit: '10mb' }));

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API = '2026-04';

// ---- Récupération auto du token Shopify (client credentials, refresh avant expiration) ----
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  const data = await r.json();
  if (!data.access_token) {
    throw new Error('token fetch failed: ' + JSON.stringify(data));
  }
  cachedToken = data.access_token;
  // refresh 1h avant l'expiration réelle
  tokenExpiry = now + ((data.expires_in || 86400) - 3600) * 1000;
  console.log('Shopify token refreshed, scope:', data.scope);
  return cachedToken;
}

function pickFile(req) {
  if (req.file) return req.file;
  if (req.files && req.files.length) return req.files[0];
  return null;
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  console.log(`>>> ${req.method} ${req.url} | content-type: ${req.headers['content-type']}`);
  next();
});

async function shopifyGraphQL(body) {
  const token = await getToken();
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function findFileUrl(filename) {
  const isPreview = filename.startsWith('preview_');
  const baseName = filename.replace(/\.[^.]+$/, '');
  const queries = [`filename:${filename}`, `filename:*${baseName}*`, baseName];

  for (const queryStr of queries) {
    const q = {
      query: `query($query: String!) {
        files(first: 20, query: $query) {
          edges { node { ... on GenericFile { url } } }
        }
      }`,
      variables: { query: queryStr }
    };
    try {
      const r = await shopifyGraphQL(q);
      console.log(`FIND attempt "${queryStr}":`, JSON.stringify(r).substring(0, 500));
      if (r.errors) { console.log('FIND GraphQL errors:', JSON.stringify(r.errors)); continue; }
      const edges = r.data && r.data.files && r.data.files.edges;
      if (edges && edges.length > 0) {
        for (const edge of edges) {
          if (!edge.node || !edge.node.url) continue;
          const url = edge.node.url;
          if (!url.includes(filename)) continue;
          if (!isPreview && url.includes('preview_')) continue;
          console.log(`FIND MATCH via "${queryStr}":`, url);
          return url;
        }
      }
    } catch (e) {
      console.log(`FIND ERROR for "${queryStr}":`, e.message);
    }
  }
  console.log(`FIND: no result for ${filename}`);
  return null;
}

async function pollFileUrl(fileId) {
  const q = {
    query: `query($id: ID!) { node(id: $id) { ... on GenericFile { url } } }`,
    variables: { id: fileId }
  };
  for (let i = 0; i < 10; i++) {
    const r = await shopifyGraphQL(q);
    const node = r.data && r.data.node;
    if (node && node.url) return node.url;
    await new Promise(res => setTimeout(res, 1500));
  }
  return null;
}

async function uploadToShopify(filePath, filename, mimeType) {
  const fileBuffer = fs.readFileSync(filePath);
  const size = fileBuffer.length;
  const mt = mimeType || 'application/octet-stream';

  const staged = await shopifyGraphQL({
    query: `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { message }
      }
    }`,
    variables: { input: [{ filename, mimeType: mt, resource: 'FILE', httpMethod: 'POST', fileSize: String(size) }] }
  });
  const target = staged.data.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([fileBuffer]), filename);
  await fetch(target.url, { method: 'POST', body: form });

  const created = await shopifyGraphQL({
    query: `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) { files { id ... on GenericFile { url } } userErrors { message } }
    }`,
    variables: { files: [{ originalSource: target.resourceUrl, contentType: 'FILE' }] }
  });
  const file = created.data.fileCreate.files[0];

  let finalUrl = file && file.url;
  if (!finalUrl && file && file.id) finalUrl = await pollFileUrl(file.id);
  return finalUrl || target.resourceUrl;
}

// =========== Génération PDF des paroles ===========
function generateLyricsPDF(outPath, recipientName, lyrics) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true
    });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const CREAM = '#F5F1EA';
    const EMERALD = '#00875A';
    const EMERALD_SOFT = '#5A8A75';
    const pageW = doc.page.width;
    const pageH = doc.page.height;

    doc.rect(0, 0, pageW, pageH).fill(CREAM);

    const M = 36;
    const IM = 50;
    doc.lineWidth(1.2).strokeColor(EMERALD)
      .rect(M, M, pageW - 2 * M, pageH - 2 * M).stroke();
    doc.lineWidth(0.4).strokeColor(EMERALD)
      .rect(M + 6, M + 6, pageW - 2 * (M + 6), pageH - 2 * (M + 6)).stroke();

    const drawCorner = (cx, cy, rotation) => {
      doc.save();
      doc.translate(cx, cy).rotate(rotation);
      doc.lineWidth(0.8).strokeColor(EMERALD);
      doc.moveTo(0, -4).lineTo(4, 0).lineTo(0, 4).lineTo(-4, 0).closePath().stroke();
      doc.moveTo(-10, 0).lineTo(-6, 0).stroke();
      doc.moveTo(6, 0).lineTo(10, 0).stroke();
      doc.moveTo(0, -10).lineTo(0, -6).stroke();
      doc.moveTo(0, 6).lineTo(0, 10).stroke();
      doc.restore();
    };
    drawCorner(M + 18, M + 18, 0);
    drawCorner(pageW - M - 18, M + 18, Math.PI / 2);
    drawCorner(pageW - M - 18, pageH - M - 18, Math.PI);
    drawCorner(M + 18, pageH - M - 18, -Math.PI / 2);

    let y = M + 60;
    const ornY = y;
    doc.lineWidth(0.6).strokeColor(EMERALD_SOFT);
    const cx = pageW / 2;
    doc.fillColor(EMERALD).moveTo(cx, ornY - 4).lineTo(cx + 4, ornY).lineTo(cx, ornY + 4).lineTo(cx - 4, ornY).closePath().fill();
    doc.strokeColor(EMERALD).moveTo(cx - 18, ornY - 3).lineTo(cx - 15, ornY).lineTo(cx - 18, ornY + 3).lineTo(cx - 21, ornY).closePath().stroke();
    doc.moveTo(cx + 18, ornY - 3).lineTo(cx + 21, ornY).lineTo(cx + 18, ornY + 3).lineTo(cx + 15, ornY).closePath().stroke();
    doc.moveTo(cx - 35, ornY).lineTo(cx - 23, ornY).stroke();
    doc.moveTo(cx + 23, ornY).lineTo(cx + 35, ornY).stroke();
    doc.moveTo(cx - 13, ornY).lineTo(cx - 6, ornY).stroke();
    doc.moveTo(cx + 6, ornY).lineTo(cx + 13, ornY).stroke();

    y += 22;

    doc.font('Times-Italic').fontSize(42).fillColor(EMERALD)
      .text('Mélodine', M, y, { width: pageW - 2 * M, align: 'center' });
    y += 52;

    const cartoucheY = y;
    const cartoucheH = 38;
    const cartoucheW = 300;
    const cartoucheX = (pageW - cartoucheW) / 2;
    doc.fillColor(EMERALD).opacity(0.06)
      .rect(cartoucheX, cartoucheY, cartoucheW, cartoucheH).fill();
    doc.opacity(1);
    doc.lineWidth(0.5).strokeColor(EMERALD)
      .rect(cartoucheX, cartoucheY, cartoucheW, cartoucheH).stroke();
    const triY = cartoucheY + cartoucheH / 2;
    doc.fillColor(EMERALD);
    doc.moveTo(cartoucheX - 8, triY).lineTo(cartoucheX, triY - 5).lineTo(cartoucheX, triY + 5).closePath().fill();
    doc.moveTo(cartoucheX + cartoucheW + 8, triY).lineTo(cartoucheX + cartoucheW, triY - 5).lineTo(cartoucheX + cartoucheW, triY + 5).closePath().fill();
    doc.fillColor(EMERALD).font('Times-Italic').fontSize(18)
      .text(`Une chanson pour ${recipientName}`, cartoucheX, cartoucheY + 11,
        { width: cartoucheW, align: 'center' });

    y = cartoucheY + cartoucheH + 28;

    const footerSpace = 70;
    const lyricsTop = y;
    const lyricsBottom = pageH - M - footerSpace;
    const lyricsHeight = lyricsBottom - lyricsTop;
    const lyricsLeft = M + IM;
    const lyricsWidth = pageW - 2 * (M + IM);

    const stanzas = String(lyrics).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

    const sizes = [13, 12, 11, 10.5, 10, 9.5, 9, 8.5, 8];
    let chosenSize = 8;
    let chosenLineGap = 3;
    let chosenStanzaGap = 12;

    for (const size of sizes) {
      const lineGap = size < 10 ? 2 : 3;
      const stanzaGap = size < 10 ? 8 : 12;
      doc.font('Times-Roman').fontSize(size);
      let total = 0;
      stanzas.forEach((stanza, i) => {
        const h = doc.heightOfString(stanza, { width: lyricsWidth, align: 'center', lineGap });
        total += h;
        if (i < stanzas.length - 1) total += stanzaGap;
      });
      if (total <= lyricsHeight) {
        chosenSize = size; chosenLineGap = lineGap; chosenStanzaGap = stanzaGap;
        break;
      }
    }

    doc.font('Times-Roman').fontSize(chosenSize);
    let realTotal = 0;
    stanzas.forEach((stanza, i) => {
      realTotal += doc.heightOfString(stanza, { width: lyricsWidth, align: 'center', lineGap: chosenLineGap });
      if (i < stanzas.length - 1) realTotal += chosenStanzaGap;
    });
    let cursorY = lyricsTop + Math.max(0, (lyricsHeight - realTotal) / 2);

    doc.fillColor(EMERALD);
    stanzas.forEach((stanza, i) => {
      doc.text(stanza, lyricsLeft, cursorY, { width: lyricsWidth, align: 'center', lineGap: chosenLineGap });
      const h = doc.heightOfString(stanza, { width: lyricsWidth, align: 'center', lineGap: chosenLineGap });
      cursorY += h + (i < stanzas.length - 1 ? chosenStanzaGap : 0);
    });

    const footerY = pageH - M - 40;
    doc.lineWidth(0.6).strokeColor(EMERALD_SOFT);
    const waveCx = pageW / 2;
    const waveY = footerY;
    doc.moveTo(waveCx - 40, waveY)
      .bezierCurveTo(waveCx - 30, waveY - 4, waveCx - 20, waveY + 4, waveCx - 10, waveY)
      .bezierCurveTo(waveCx, waveY - 4, waveCx + 10, waveY + 4, waveCx + 20, waveY)
      .bezierCurveTo(waveCx + 30, waveY - 4, waveCx + 35, waveY, waveCx + 40, waveY)
      .stroke();
    doc.fillColor(EMERALD).moveTo(waveCx, waveY - 3).lineTo(waveCx + 3, waveY).lineTo(waveCx, waveY + 3).lineTo(waveCx - 3, waveY).closePath().fill();

    doc.fillColor(EMERALD_SOFT).font('Times-Italic').fontSize(9)
      .text('Créé avec passion par l\'équipe Mélodine', M, footerY + 14,
        { width: pageW - 2 * M, align: 'center' });
    doc.fillColor(EMERALD).font('Times-Roman').fontSize(9)
      .text('melodine-paris.fr', M, footerY + 26,
        { width: pageW - 2 * M, align: 'center' });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// =========== Endpoints ===========

app.post('/trim', anyFile, (req, res) => {
  const file = pickFile(req);
  console.log('TRIM: file =', file ? file.originalname + ' / ' + file.size + ' bytes' : 'NONE');
  if (!file) return res.status(400).send('no file received');
  const out = path.join(os.tmpdir(), `trim_${Date.now()}.mp3`);
  execFile('ffmpeg', ['-y', '-i', file.path, '-t', '30', '-acodec', 'libmp3lame', '-b:a', '192k', out], (err) => {
    fs.unlink(file.path, () => {});
    if (err) { console.log('FFMPEG ERROR:', err.message); return res.status(500).send('ffmpeg error: ' + err.message); }
    res.sendFile(out, () => fs.unlink(out, () => {}));
  });
});

app.post('/save_audio', anyFile, async (req, res) => {
  const file = pickFile(req);
  if (!file) return res.status(400).send('no file received');
  const leadId = req.body.lead_id || 'unknown';
  try {
    const url = await uploadToShopify(file.path, `${leadId}.mp3`, 'audio/mpeg');
    fs.unlink(file.path, () => {});
    res.json({ lead_id: leadId, url });
  } catch (e) { console.log('SAVE ERROR:', e.message); res.status(500).send('upload error: ' + e.message); }
});

app.post('/save_preview', anyFile, async (req, res) => {
  const file = pickFile(req);
  if (!file) return res.status(400).send('no file received');
  const leadId = req.body.lead_id || 'unknown';
  try {
    const url = await uploadToShopify(file.path, `preview_${leadId}.mp3`, 'audio/mpeg');
    fs.unlink(file.path, () => {});
    res.json({ lead_id: leadId, url });
  } catch (e) { console.log('SAVE ERROR:', e.message); res.status(500).send('upload error: ' + e.message); }
});

app.post('/save_lyrics', async (req, res) => {
  const { lead_id, lyrics } = req.body || {};
  if (!lead_id || !lyrics) return res.status(400).json({ error: 'lead_id and lyrics required' });
  const tmp = path.join(os.tmpdir(), `${lead_id}_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmp, String(lyrics), 'utf8');
    const url = await uploadToShopify(tmp, `${lead_id}.txt`, 'text/plain');
    fs.unlink(tmp, () => {});
    res.json({ lead_id, url });
  } catch (e) { console.log('SAVE LYRICS ERROR:', e.message); res.status(500).send('upload error: ' + e.message); }
});

app.post('/save_pdf', async (req, res) => {
  const { lead_id, recipient_name, lyrics } = req.body || {};
  if (!lead_id || !recipient_name || !lyrics) {
    return res.status(400).json({ error: 'lead_id, recipient_name and lyrics required' });
  }
  const tmp = path.join(os.tmpdir(), `${lead_id}_${Date.now()}.pdf`);
  try {
    await generateLyricsPDF(tmp, recipient_name, lyrics);
    const url = await uploadToShopify(tmp, `${lead_id}.pdf`, 'application/pdf');
    fs.unlink(tmp, () => {});
    res.json({ lead_id, url });
  } catch (e) { console.log('SAVE PDF ERROR:', e.message); res.status(500).send('pdf error: ' + e.message); }
});

app.get('/ready', async (req, res) => {
  const leadId = req.query.lead_id;
  if (!leadId) return res.status(400).json({ ready: false, error: 'no lead_id' });
  try {
    const url = await findFileUrl(`preview_${leadId}.mp3`);
    if (url) return res.json({ ready: true, url });
    res.json({ ready: false });
  } catch (e) { console.log('READY ERROR:', e.message); res.json({ ready: false }); }
});

app.get('/full', async (req, res) => {
  const leadId = req.query.lead_id;
  if (!leadId) return res.status(400).json({ ready: false, error: 'no lead_id' });
  try {
    const url = await findFileUrl(`${leadId}.mp3`);
    if (url) return res.json({ ready: true, url });
    res.json({ ready: false });
  } catch (e) { console.log('FULL ERROR:', e.message); res.json({ ready: false }); }
});

app.get('/lyrics', async (req, res) => {
  const leadId = req.query.lead_id;
  if (!leadId) return res.status(400).json({ ready: false, error: 'no lead_id' });
  try {
    const url = await findFileUrl(`${leadId}.txt`);
    if (url) return res.json({ ready: true, url });
    res.json({ ready: false });
  } catch (e) { console.log('LYRICS ERROR:', e.message); res.json({ ready: false }); }
});

app.get('/pdf', async (req, res) => {
  const leadId = req.query.lead_id;
  if (!leadId) return res.status(400).json({ ready: false, error: 'no lead_id' });
  try {
    const url = await findFileUrl(`${leadId}.pdf`);
    if (url) return res.json({ ready: true, url });
    res.json({ ready: false });
  } catch (e) { console.log('PDF ERROR:', e.message); res.json({ ready: false }); }
});

app.get('/', (req, res) => res.send('Melodine audio server OK'));

app.use((err, req, res, next) => {
  console.log('GLOBAL ERROR:', err.message);
  res.status(400).send('error: ' + err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on ' + PORT));
