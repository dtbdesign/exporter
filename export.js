import puppeteer from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// === CONFIG FROM ENV ===
const COOKIES_PATH = './cookies.json';
const FIGMA_URL = process.env.FIGMA_URL;
const PLUGIN_BUTTON_TEXT = 'Re-sync Google Sheets Data';
const EXPORT_DIR = path.resolve('./exports');

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const FILE_KEY = process.env.FILE_KEY;
const NODE_IDS = process.env.NODE_IDS ? process.env.NODE_IDS.split(',') : ['0:1'];
const FORMAT = 'png';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BUCKET_NAME = process.env.BUCKET_NAME;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function uploadToSupabase(filePath, fileName) {
  const fileBuffer = fs.readFileSync(filePath);
  const contentType = mime.lookup(fileName) || 'application/octet-stream';

  await supabase.storage.from(BUCKET_NAME).remove([`figma/${fileName}`]);

  const { error } = await supabase.storage.from(BUCKET_NAME).upload(`figma/${fileName}`, fileBuffer, {
    contentType,
    upsert: true,
  });

  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(`figma/${fileName}`);
  return `${data.publicUrl}?t=${Date.now()}`;
}

async function exportFromFigmaAPI(version) {
  const ids = NODE_IDS.join(',');
  const response = await axios.get(`https://api.figma.com/v1/images/${FILE_KEY}`, {
    headers: { 'X-Figma-Token': FIGMA_TOKEN },
    params: { ids, format: FORMAT, version, ts: Date.now() },
  });

  const images = response.data.images;
  const uploadedUrls = [];

  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR);

  for (const [nodeId, url] of Object.entries(images)) {
    const imgRes = await axios.get(url, { responseType: 'arraybuffer' });
    const fileName = `${nodeId.replace(':', '_')}_${Date.now()}.${FORMAT}`;
    const filePath = path.join(EXPORT_DIR, fileName);
    fs.writeFileSync(filePath, imgRes.data);

    const publicUrl = await uploadToSupabase(filePath, fileName);
    uploadedUrls.push(publicUrl);
    console.log(`✅ Uploaded: ${publicUrl}`);
  }

  return uploadedUrls;
}

async function runFigmaExport() {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath,
    headless: chromium.headless,
    defaultViewport: null,
  });

  const page = await browser.newPage();
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH));
  await page.setCookie(...cookies);

  console.log('🟡 Opening Figma...');
  await page.goto(FIGMA_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  let pluginClicked = false;
  const maxWait = 30000;
  const start = Date.now();

  while (!pluginClicked && Date.now() - start < maxWait) {
    pluginClicked = await page.evaluate(buttonText => {
      const elements = document.querySelectorAll('div.plugin_panel--relaunchButtonName--Ol-Gy div');
      for (const el of elements) {
        if (el.textContent.trim() === buttonText) {
          el.click();
          return true;
        }
      }
      return false;
    }, PLUGIN_BUTTON_TEXT);
    if (!pluginClicked) await new Promise(res => setTimeout(res, 1000));
  }

  if (!pluginClicked) throw new Error('❌ Plugin button not found.');

  console.log('✅ Plugin clicked. Waiting for sync...');
  const pluginStart = Date.now();
  const timeout = 90000;
  let syncingDone = false;

  while (!syncingDone && Date.now() - pluginStart < timeout) {
    syncingDone = await page.evaluate(() => {
      return !Array.from(document.querySelectorAll('body *'))
        .filter(el => el.offsetParent !== null)
        .some(el => el.textContent.includes('Fetching images'));
    });
    if (!syncingDone) await new Promise(res => setTimeout(res, 1000));
  }

  if (!syncingDone) throw new Error('❌ Plugin sync did not finish in time.');

  console.log('✅ Sync finished. Waiting for Figma to update backend...');
  await new Promise(res => setTimeout(res, 15000));

  const fileResponse = await axios.get(`https://api.figma.com/v1/files/${FILE_KEY}`, {
    headers: { 'X-Figma-Token': FIGMA_TOKEN },
  });
  const version = fileResponse.data.version;

  console.log('📦 Starting export via Figma API...');
  const urls = await exportFromFigmaAPI(version);

  await browser.close();
  return urls;
}

export default runFigmaExport;
