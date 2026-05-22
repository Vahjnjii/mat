import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCRIPT_TEXT = process.argv[2] || "A lone samurai stands in the rain. Lightning strikes. He draws his blade.";

async function run() {
  console.log("Starting backend headless rendering...");

  const serverPort = 3000;
  const server = spawn('npm', ['run', 'dev'], { stdio: 'pipe' });
  
  await new Promise(r => setTimeout(r, 5000));
  
  const outDir = path.join(process.cwd(), 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  console.log("Launching headless browser...");
  const browser = await puppeteer.launch({ 
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--autoplay-policy=no-user-gesture-required']
  });
  
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { window.isHeadless = true; });
  
  // Set download behavior safely
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: outDir
  });

  await page.setViewport({ width: 720, height: 1280, deviceScaleFactor: 2 });
  
  console.log("Navigating to local app...");
  await page.goto(`http://localhost:${serverPort}`, { waitUntil: 'networkidle0', timeout: 60000 });
  
  console.log("Injecting script and triggering generation...");
  
  await page.waitForSelector('textarea');
  await page.$eval('textarea', el => el.value = '');
  await page.type('textarea', SCRIPT_TEXT);
  await page.keyboard.press('Enter');
  
  console.log("Generation started. Waiting for rendering to complete (this may take a while)...");
  
  // Wait for the final video blob to be generated
  await page.waitForFunction('!!window._finalVideoBlob', { timeout: 30 * 60 * 1000 }); // 30 min timeout
  
  console.log("Rendering finished! Triggering download for artifact extraction...");
  
  // Trigger the download programmatically
  await page.evaluate(() => {
    const blob = window._finalVideoBlob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rendered-video.webm';
    a.click();
  });

  // Wait for file to arrive in outDir
  console.log("Waiting for file to write to disk...");
  await new Promise(resolve => {
    const checkFile = setInterval(() => {
      if (fs.existsSync(path.join(outDir, 'rendered-video.webm'))) {
        // give it a second to finish flushing
        setTimeout(() => {
          clearInterval(checkFile);
          resolve();
        }, 1000);
      }
    }, 1000);
  });
  
  console.log("Download complete!");
  
  await browser.close();
  server.kill();
  process.exit(0);
}

run().catch(err => {
  console.error("Render failed:", err);
  process.exit(1);
});
