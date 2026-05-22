/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// v1.0.1 - Sidebar & GitHub Pages Fix
import { useState, useRef, useEffect, useMemo, FormEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Loader2, 
  Sparkles, 
  Download, 
  RefreshCw, 
  Zap, 
  Image as ImageIcon, 
  ArrowRight, 
  Settings, 
  Volume2, 
  Video, 
  Play, 
  Pause,
  Square,
  Clock,
  ChevronDown,
  ChevronLeft,
  PenTool,
  Menu,
  ArrowUp
} from 'lucide-react';
import { Octokit } from '@octokit/rest';

if (typeof document !== 'undefined') {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&display=swap';
  document.head.appendChild(link);
}

import { GoogleGenAI, Modality } from "@google/genai";

let _aiInstances: any[] = [];
let currentApiIndex = 0;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const generateContentWithRetry = async (params: any, clientProvidedKeys?: string[]): Promise<any> => {
  let keys = clientProvidedKeys || [];
  if (!keys || keys.length === 0) {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('GEMINI_API_KEYS');
      if (stored) {
        try {
          if (stored.startsWith('[')) {
            keys = JSON.parse(stored);
          } else {
            keys = stored.split(/[,\s\n]+/).map(k => k.trim()).filter(Boolean);
          }
        } catch(e) {
          keys = stored.split(/[,\s\n]+/).map(k => k.trim()).filter(Boolean);
        }
      }
    }
  }

  if (!keys || keys.length === 0) {
    throw new Error("No Gemini API keys found. Please configure them in Settings.");
  }

  let lastError: any = null;
  let attempts = 0;
  while (attempts < keys.length) {
    if (currentApiIndex >= keys.length) {
      currentApiIndex = 0;
    }
      
    const client = new GoogleGenAI({ apiKey: keys[currentApiIndex] });
    const currentAttemptIndex = currentApiIndex;
    currentApiIndex = (currentApiIndex + 1) % keys.length;
    attempts++;
      
    try {
      const res = await client.models.generateContent(params);
      return res;
    } catch (err: any) {
      lastError = err;
      const msg = (typeof err === 'string' ? err : (err.message || JSON.stringify(err) || "")).toLowerCase();
        
      if (msg.includes('quota') || msg.includes('429') || msg.includes('limit') || msg.includes('exhausted')) {
         console.warn(`Key ${currentAttemptIndex} exhausted, rotating...`);
         if (attempts < keys.length) await sleep(2000);
         continue; 
      }
      console.warn(`Key failed (attempt ${attempts}), rotating... Error:`, err);
      if (attempts < keys.length) await sleep(1000);
    }
  }
    
  const errorString = typeof lastError === 'string' ? lastError : (lastError.message || JSON.stringify(lastError));
  throw new Error(`Exhausted all ${keys.length} provided Gemini API keys. Final error: ${errorString}`);
};


interface Scene {
  timestamp: number;
  prompt: string;
  text: string;
  imageUrl?: string;
  blob?: Blob;
}

interface Project {
  id: string;
  userId: string;
  script: string;
  videoUrl?: string; // e.g. from GitHub Release
  createdAt: Date;
  status: 'rendering' | 'ready';
}

interface CinematicParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  opacity: number;
  type: 'shadow' | 'ember' | 'smoke';
  color?: string;
  rotation?: number;
  vr?: number;
}

const VOICES = [
  { id: 'Charon', name: 'Deep & Resonant (Charon)' },
  { id: 'Puck', name: 'Youthful & Light (Puck)' },
  { id: 'Kore', name: 'Soft & Warm (Kore)' },
  { id: 'Fenrir', name: 'Gravelly & Strong (Fenrir)' },
];

export default function App() {
  const getProjectRepoName = () => {
    if (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io')) {
      const parts = window.location.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        return parts[0];
      }
    }
    return 'ai-studio-video-projects';
  };

  // Base state
  const [script, setScript] = useState('');
  const [originalScript, setOriginalScript] = useState('');
  const [apiKeysInputText, setApiKeysInputText] = useState('');
  const [imageUrlsInputText, setImageUrlsInputText] = useState('');
  const [saveStatus, setSaveStatus] = useState<{ type: 'idle' | 'saving' | 'success' | 'error', message: string }>({ type: 'idle', message: '' });
  const [selectedVoice, setSelectedVoice] = useState('Charon');
  const [isGenerating, setIsGenerating] = useState(() => {
    if (typeof window !== 'undefined') {
      return !!localStorage.getItem('lastActiveJobId');
    }
    return false;
  });
  const [regeneratingIdx, setRegeneratingIdx] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoadingProject, setIsLoadingProject] = useState(false);

  // GitHub Auth & Settings State
  const [user, setUser] = useState<any | null>(null);
  const [githubToken, setGithubToken] = useState<string | null>(null);
  const [githubTokenInput, setGithubTokenInput] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [apiKeys, setApiKeys] = useState<string[]>([]);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [dbProjects, setDbProjects] = useState<Project[]>([]);
  const [autoGen, setAutoGen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const pId = params.get('projectId');
      if (pId) {
        if (params.get('render') === 'true') {
          (window as any).isHeadless = true;
        }
        if (params.get('autoGen') === 'true') {
          (window as any).isHeadless = true; // Auto generation happens entirely in headless typically
        }
        return pId;
      }
      return localStorage.getItem('lastProjectId');
    }
    return null;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autoGen') === 'true') {
        setAutoGen(true);
      }
    }
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      localStorage.setItem('lastProjectId', selectedProjectId);
    }
  }, [selectedProjectId]);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    setIsSidebarOpen(window.innerWidth >= 1024);
  }, []);

  // Auto Generation flow from Github action
  useEffect(() => {
    if (autoGen && script && !isGenerating && originalScript === script) {
      // Small timeout to allow DOM to settle
      setTimeout(() => {
        generateFullVideo(script);
      }, 1000);
      setAutoGen(false); // only run once
    }
  }, [autoGen, script, isGenerating, originalScript]);

  useEffect(() => {
    if (selectedProjectId && githubToken && user) {
      const proj = dbProjects.find(p => p.id === selectedProjectId);
      if (proj && proj.status === 'rendering') {
        // Skip GitHub fetch while it's actively rendering, let the job polling handle it
        return;
      }

      const loadProjectData = async () => {
        setIsLoadingProject(true);
        const octokit = new Octokit({ auth: githubToken });
        const owner = user.login;
        const repo = getProjectRepoName();

        try {
          // Fetch script
          const { data: scriptContent } = await octokit.repos.getContent({
            owner, repo, path: `projects/${selectedProjectId}/script.txt`
          }) as any;
          const decodedScript = decodeURIComponent(escape(atob(scriptContent.content)));
          setScript(decodedScript);
          setOriginalScript(decodedScript);

          // Try to fetch metadata for advanced recovery (subtitles, prompts)
          let metadata = null;
          try {
            const { data: metaContent } = await octokit.repos.getContent({
              owner, repo, path: `projects/${selectedProjectId}/metadata.json`
            }) as any;
            metadata = JSON.parse(decodeURIComponent(escape(atob(metaContent.content))));
            
            if (metadata?.remoteGenerate && (window as any).isHeadless) {
              if (metadata.keys && metadata.keys.length > 0) setApiKeys(metadata.keys);
              if (metadata.workers && metadata.workers.length > 0) setImageUrls(metadata.workers);
            }
          } catch (e) {
            console.log("No metadata.json found, falling back to timeline parsing");
          }

          // Fetch timeline
          try {
            const { data: timelineContent } = await octokit.repos.getContent({
              owner, repo, path: `projects/${selectedProjectId}/timeline.txt`
            }) as any;
            const timelineLines = decodeURIComponent(escape(atob(timelineContent.content))).split('\n');
            
            // Reconstruct scenes
            const reconstructedScenes: Scene[] = [];
            let currentTimestamp = 0;
            let sceneIdx = 0;
            for (let i = 0; i < timelineLines.length; i++) {
              const line = timelineLines[i];
              if (line.startsWith('file ')) {
                const imgPath = line.replace('file ', '').replace(/'/g, '');
                const { data: imgData } = await octokit.repos.getContent({
                  owner, repo, path: `projects/${selectedProjectId}/${imgPath}`
                }) as any;
                
                const durationLine = timelineLines[i+1];
                const duration = durationLine?.startsWith('duration ') ? parseFloat(durationLine.replace('duration ', '')) : 5;
                
                reconstructedScenes.push({
                  timestamp: currentTimestamp,
                  prompt: metadata?.scenes?.[sceneIdx]?.prompt || `Scene ${sceneIdx + 1}`,
                  text: metadata?.scenes?.[sceneIdx]?.text || "...",
                  imageUrl: `data:image/webp;base64,${imgData.content.replace(/\s/g, '')}`
                });
                currentTimestamp += duration;
                sceneIdx++;
                i++; // Skip duration line
              }
            }
            setScenes(reconstructedScenes);
          } catch(e: any) {
            console.log("No timeline.txt found, skipping timeline reconstruction.");
          }
          
          try {
            const { data: audioData } = await octokit.repos.getContent({
              owner, repo, path: `projects/${selectedProjectId}/audio.wav`
            }) as any;
            setAudioUrl(`data:audio/wav;base64,${audioData.content.replace(/\s/g, '')}`);
          } catch(e: any) {
            console.log("No audio.wav found");
          }

        } catch (error) {
          console.error("Failed to load project details:", error);
        } finally {
          setIsLoadingProject(false);
        }
      };
      
      loadProjectData();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, githubToken, user]);

  const [showVoiceSelector, setShowVoiceSelector] = useState(false);

  
  const blobToBase64 = async (blob: Blob): Promise<string> => {
    const arrayBuffer = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const uploadRawProjectToGitHub = async (
    octokit: Octokit,
    userLogin: string,
    timestamp: string,
    scriptText: string,
    keys: string[],
    workers: string[]
  ) => {
    const owner = userLogin;
    const repo = getProjectRepoName();
    
    try {
      await octokit.repos.get({ owner, repo });
    } catch (e: any) {
      if (e.status === 404) {
        await octokit.repos.createForAuthenticatedUser({
          name: repo,
          description: 'Projects generated by AI Studio. Rendered automatically via Actions.',
          private: true,
          auto_init: true
        });
        await sleep(3000);
      } else {
        throw e;
      }
    }

    const { data: ref } = await octokit.git.getRef({ owner, repo, ref: 'heads/main' }).catch(() => ({ data: { object: { sha: '' } } }));
    let baseTreeSha = '';
    let refSha = ref?.object?.sha;
    if (refSha) {
      const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: refSha });
      baseTreeSha = commit.tree.sha;
    }

    const treeData: any[] = [];
    const scriptBase64 = btoa(unescape(encodeURIComponent(scriptText)));
    const { data: scriptBlob } = await octokit.git.createBlob({ owner, repo, content: scriptBase64, encoding: 'base64' });
    treeData.push({ path: `projects/${timestamp}/script.txt`, mode: '100644', type: 'blob', sha: scriptBlob.sha });
    
    // Pass API keys securely to the headless browser via metadata so it can run the generation
    const metaDataString = JSON.stringify({ keys, workers, remoteGenerate: true });
    const metaBase64 = btoa(unescape(encodeURIComponent(metaDataString)));
    const { data: metaBlob } = await octokit.git.createBlob({ owner, repo, content: metaBase64, encoding: 'base64' });
    treeData.push({ path: `projects/${timestamp}/metadata.json`, mode: '100644', type: 'blob', sha: metaBlob.sha });

    const workflowContent = `name: AI Video Generator

on:
  push:
    paths:
      - 'projects/**/script.txt'
      - 'projects/**/timeline.txt'
  workflow_dispatch:
    inputs:
      project_id:
        description: 'Project ID to render'
        required: true

permissions:
  contents: write

jobs:
  render:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install Puppeteer and FFmpeg
        run: |
          npm install puppeteer
          sudo apt-get update && sudo apt-get install -y ffmpeg
        
      - name: Render Video with Puppeteer
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          APP_URL: ${window.location.href.split('?')[0].replace(/\/$/, '')}/
        run: |
          cat << 'EOF' > render.cjs
          const puppeteer = require('puppeteer');
          const fs = require('fs');
          
          async function run() {
            const projId = process.argv[2];
            const appUrl = process.argv[3];
            const autoGen = process.argv[4] === 'true'; // flag to decide query param
            const token = process['env']['GITHUB_TOKEN'];
            
            const browser = await puppeteer.launch({
              headless: "new",
              args: ['--no-sandbox', '--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--use-gl=egl', '--window-size=1080,1920']
            });
            
            const page = await browser.newPage();
            
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: process.cwd() });
            
            await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
            
            await page.evaluateOnNewDocument((ghToken) => {
              localStorage.setItem('GITHUB_TOKEN', ghToken);
              window.isHeadless = true;
            }, token);
            
            const url = \`\${appUrl}?projectId=\${projId}&\${autoGen ? 'autoGen=true' : 'render=true'}\`;
            console.log(\`Navigating to \${url}\`);
            
            await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
            
            console.log("Waiting for generation and render to finish. Generative steps can take ~10 minutes...");
            await page.waitForFunction('!!window._renderComplete', { timeout: 45 * 60 * 1000 });
            
            console.log("Render complete on frontend! Waiting for download...");
            
            const checkFile = () => new Promise(r => {
              const iv = setInterval(() => {
                if (fs.existsSync('preview.webm')) {
                  clearInterval(iv);
                  setTimeout(r, 2000); 
                }
              }, 1000);
            });
            
            await checkFile();
            await browser.close();
          }
          run().catch(e => { console.error(e); process.exit(1); });
          EOF
          
          CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r \${{ github.sha }} || echo "")
          PROJECT_ID="\${{ github.event.inputs.project_id }}"
          IS_AUTOGEN="false"
          
          if [ -z "$PROJECT_ID" ]; then
            for path in $(echo "$CHANGED_FILES" | grep 'script.txt\|timeline.txt' || true); do
              if [ -f "$path" ]; then
                PROJECT_ID=$(basename $(dirname "$path"))
                if [[ "$path" == *"script.txt"* ]]; then
                  IS_AUTOGEN="true"
                fi
                break
              fi
            done
          fi
          
          if [ ! -z "$PROJECT_ID" ]; then
            echo "Running headless with Project $PROJECT_ID | AutoGen: $IS_AUTOGEN"
            node render.cjs "$PROJECT_ID" "\${{ env.APP_URL }}" "$IS_AUTOGEN"
            
            if [ -f preview.webm ]; then
              echo "Converting WebM to MP4..."
              ffmpeg -i preview.webm -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k output.mp4
              gh release create "vid-\${PROJECT_ID}" output.mp4 --title "Video \${PROJECT_ID}" --notes "Rendered MP4 background generation via Headless Browser Action" || true
            else
              echo "Error: preview.webm not found"
              exit 1
            fi
          fi
`;
    const workflowBase64 = btoa(encodeURIComponent(workflowContent).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16))));
    const { data: workflowBlob } = await octokit.git.createBlob({ owner, repo, content: workflowBase64, encoding: 'base64' });
    treeData.push({ path: `.github/workflows/ai-video-generator.yml`, mode: '100644', type: 'blob', sha: workflowBlob.sha });

    const treeParams: any = { owner, repo, tree: treeData };
    if (baseTreeSha) treeParams.base_tree = baseTreeSha;
    const { data: newTree } = await octokit.git.createTree(treeParams);
    const commitParams: any = { owner, repo, message: `Auto-generate video project ${timestamp}`, tree: newTree.sha };
    if (refSha) commitParams.parents = [refSha];
    const { data: newCommit } = await octokit.git.createCommit(commitParams);
    await octokit.git.updateRef({ owner, repo, ref: 'heads/main', sha: newCommit.sha });
  };
  
  const uploadProjectToGitHub = async (
    octokit: Octokit,
    userLogin: string,
    timestamp: string,
    audioBase64: string,
    imagesPayload: { filename: string, base64: string }[],
    timelineText: string,
    scriptText: string,
    scenesData: Scene[]
  ) => {
    const owner = userLogin;
    const repo = getProjectRepoName();
    
    try {
      await octokit.repos.get({ owner, repo });
    } catch (e: any) {
      if (e.status === 404) {
        await octokit.repos.createForAuthenticatedUser({
          name: repo,
          description: 'Projects generated by AI Studio. Rendered automatically via Actions.',
          private: true,
          auto_init: true
        });
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }

    let refSha;
    let baseTreeSha;
    try {
      const { data: ref } = await octokit.git.getRef({ owner, repo, ref: 'heads/main' });
      refSha = ref.object.sha;
      const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: refSha });
      baseTreeSha = commit.tree.sha;
    } catch (e: any) {
       baseTreeSha = undefined;
    }

    const treeData: any[] = [];
    
    // Generate SRT text
    let srtText = "";
    for (let i = 0; i < scenesData.length; i++) {
        const scene = scenesData[i];
        const nextTimestamp = i < scenesData.length - 1 ? scenesData[i+1].timestamp : scene.timestamp + 5; // guess 5s if last
        
        const formatTime = (seconds: number) => {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            const ms = Math.floor((seconds % 1) * 1000);
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
        };

        // Break text into lines
        const words = scene.text.split(' ');
        let chunks = [];
        for (let j = 0; j < Math.max(1, words.length); j+=4) {
            chunks.push(words.slice(j, j + 4).join(' '));
        }

        // We divide the scene's duration among the text chunks
        const durationPerChunk = (nextTimestamp - scene.timestamp) / Math.max(1, chunks.length);
        
        for (let k = 0; k < chunks.length; k++) {
            const startStr = formatTime(scene.timestamp + (k * durationPerChunk));
            const endStr = formatTime(scene.timestamp + ((k + 1) * durationPerChunk));
            srtText += `${i * 100 + k + 1}\n${startStr} --> ${endStr}\n<font color="#ffc400"><b>${chunks[k]}</b></font>\n\n`;
        }
    }
    const srtBase64 = btoa(unescape(encodeURIComponent(srtText)));
    const { data: srtBlob } = await octokit.git.createBlob({ owner, repo, content: srtBase64, encoding: 'base64' });
    treeData.push({ path: `projects/${timestamp}/subtitles.srt`, mode: '100644', type: 'blob', sha: srtBlob.sha });

    for (const img of imagesPayload) {
      const { data: blob } = await octokit.git.createBlob({ owner, repo, content: img.base64, encoding: 'base64' });
      treeData.push({ path: `projects/${timestamp}/images/${img.filename}`, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const { data: audioBlob } = await octokit.git.createBlob({ owner, repo, content: audioBase64, encoding: 'base64' });
    treeData.push({ path: `projects/${timestamp}/audio.wav`, mode: '100644', type: 'blob', sha: audioBlob.sha });

    const timelineBase64 = btoa(unescape(encodeURIComponent(timelineText)));
    const { data: timelineBlob } = await octokit.git.createBlob({ owner, repo, content: timelineBase64, encoding: 'base64' });
    treeData.push({ path: `projects/${timestamp}/timeline.txt`, mode: '100644', type: 'blob', sha: timelineBlob.sha });

    const scriptBase64 = btoa(unescape(encodeURIComponent(scriptText)));
    const { data: scriptBlob } = await octokit.git.createBlob({ owner, repo, content: scriptBase64, encoding: 'base64' });
    treeData.push({ path: `projects/${timestamp}/script.txt`, mode: '100644', type: 'blob', sha: scriptBlob.sha });

    const metaDataString = JSON.stringify({ scenes: scenesData.map(s => ({ prompt: s.prompt, text: s.text, timestamp: s.timestamp })) });
    const metaBase64 = btoa(unescape(encodeURIComponent(metaDataString)));
    const { data: metaBlob } = await octokit.git.createBlob({ owner, repo, content: metaBase64, encoding: 'base64' });
    treeData.push({ path: `projects/${timestamp}/metadata.json`, mode: '100644', type: 'blob', sha: metaBlob.sha });

    const workflowContent = `name: AI Video Generator

on:
  push:
    paths:
      - 'projects/**/timeline.txt'
  workflow_dispatch:
    inputs:
      project_id:
        description: 'Project ID to render'
        required: true

permissions:
  contents: write

jobs:
  render:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install Puppeteer and FFmpeg
        run: |
          npm install puppeteer
          sudo apt-get update && sudo apt-get install -y ffmpeg
        
      - name: Render Video with Puppeteer
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          APP_URL: ${window.location.href.split('?')[0].replace(/\/$/, '')}/
        run: |
          cat << 'EOF' > render.cjs
          const puppeteer = require('puppeteer');
          const fs = require('fs');
          
          async function run() {
            // Use global object to avoid Vite crashing or altering process.env
            const projId = process.argv[2];
            const appUrl = process.argv[3];
            const token = process['env']['GITHUB_TOKEN'];
            
            const browser = await puppeteer.launch({
              headless: "new",
              args: ['--no-sandbox', '--disable-web-security', '--autoplay-policy=no-user-gesture-required', '--use-gl=egl', '--window-size=1080,1920']
            });
            
            const page = await browser.newPage();
            
            // Allow downloads
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
              behavior: 'allow',
              downloadPath: process.cwd()
            });
            
            await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
            
            await page.evaluateOnNewDocument((ghToken) => {
              localStorage.setItem('GITHUB_TOKEN', ghToken);
              window.isHeadless = true;
            }, token);
            
            // Clean up appUrl logic
            const url = \`\${appUrl}?projectId=\${projId}&render=true\`;
            console.log(\`Navigating to \${url}\`);
            
            await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
            
            console.log("Waiting for render to finish... This takes the duration of the audio.");
            await page.waitForFunction('!!window._renderComplete', { timeout: 30 * 60 * 1000 });
            
            console.log("Render complete on frontend! Waiting for download...");
            
            const checkFile = () => new Promise(r => {
              const iv = setInterval(() => {
                if (fs.existsSync('preview.webm')) {
                  clearInterval(iv);
                  setTimeout(r, 2000); // wait a bit for file to flush
                }
              }, 1000);
            });
            
            await checkFile();
            await browser.close();
          }
          run().catch(e => { console.error(e); process.exit(1); });
          EOF
          
          CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r \${{ github.sha }} || echo "")
          PROJECT_ID="\${{ github.event.inputs.project_id }}"
          
          if [ -z "$PROJECT_ID" ]; then
            for timeline in $(echo "$CHANGED_FILES" | grep 'timeline.txt' || true); do
              if [ -f "$timeline" ]; then
                PROJECT_ID=$(basename $(dirname "$timeline"))
                break
              fi
            done
          fi
          
          if [ ! -z "$PROJECT_ID" ]; then
            echo "Rendering project $PROJECT_ID"
            node render.cjs "$PROJECT_ID" "\${{ env.APP_URL }}"
            
            if [ -f preview.webm ]; then
              echo "Converting WebM to MP4..."
              ffmpeg -i preview.webm -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k output.mp4
              gh release create "vid-\${PROJECT_ID}" output.mp4 --title "Video \${PROJECT_ID}" --notes "Rendered exact MP4 preview via Headless Browser Action" || true
            else
              echo "Error: preview.webm not found"
              exit 1
            fi
          fi
`;
    const workflowBase64 = btoa(encodeURIComponent(workflowContent).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16))));
    const { data: workflowBlob } = await octokit.git.createBlob({ owner, repo, content: workflowBase64, encoding: 'base64' });
    treeData.push({ path: `.github/workflows/ai-video-generator.yml`, mode: '100644', type: 'blob', sha: workflowBlob.sha });

    const treeParams: any = { owner, repo, tree: treeData };
    if (baseTreeSha) treeParams.base_tree = baseTreeSha;
    
    const { data: newTree } = await octokit.git.createTree(treeParams);

    const commitParams: any = { owner, repo, message: `Add video project ${timestamp}`, tree: newTree.sha };
    if (refSha) commitParams.parents = [refSha];
    
    const { data: newCommit } = await octokit.git.createCommit(commitParams);

    if (refSha) {
      await octokit.git.updateRef({ owner, repo, ref: 'heads/main', sha: newCommit.sha });
    } else {
      await octokit.git.createRef({ owner, repo, ref: 'refs/heads/main', sha: newCommit.sha });
    }
  };
  
  const [showSettings, setShowSettings] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [showInputBar, setShowInputBar] = useState(true);

  const fetchProjects = async (octokit: Octokit, userLogin: string) => {
    try {
      const { data: tree } = await octokit.git.getTree({
        owner: userLogin,
        repo: getProjectRepoName(),
        tree_sha: 'main:projects'
      });
      
      const { data: releases } = await octokit.repos.listReleases({
        owner: userLogin,
        repo: getProjectRepoName(),
        per_page: 50
      });
      
      const projects: Project[] = (tree.tree || []).filter(item => item.type === 'tree').map(item => {
        const pId = item.path || '';
        const release = releases.find(r => r.tag_name === `vid-${pId}`);
        const asset = release?.assets.find(a => a.name === 'output.mp4');
        
        return {
           id: pId,
           userId: userLogin,
           script: "Project on GitHub", // Can fetch script.txt if needed
           videoUrl: asset ? asset.browser_download_url : undefined,
           createdAt: new Date(parseInt(pId || "0")),
           status: (asset ? 'ready' : 'rendering') as 'ready' | 'rendering'
        };
      }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      
      setDbProjects(projects);
      return projects;
    } catch (err) {
      console.log("No projects yet or error fetching:", err);
      return [];
    }
  };

  const fetchUserData = async (token: string) => {
    try {
      const octokit = new Octokit({ auth: token });
      const { data: userData } = await octokit.users.getAuthenticated();
      setUser(userData);
      setGithubToken(token);
      localStorage.setItem('GITHUB_TOKEN', token);

      // Fetch Gist settings
      const { data: gists } = await octokit.gists.list();
      const settingsGist = gists.find(g => g.description === 'AI Studio Video Settings');
      if (settingsGist) {
        // We no longer load settings from gist as they are backend protected
      }

      // Fetch Projects mapping
      await fetchProjects(octokit, userData.login);
    } catch (e) {
      console.error(e);
    } finally {
      setIsAuthLoading(false);
    }
  };

  useEffect(() => {
    let interval: any;
    if (githubToken && user) {
       interval = setInterval(() => {
          if (dbProjects.some(p => p.status === 'rendering')) {
             const o = new Octokit({ auth: githubToken });
             fetchProjects(o, user.login);
          }
       }, 15000); // Check every 15s if we have rendering projects
    }
    return () => clearInterval(interval);
  }, [githubToken, user, dbProjects]);

  useEffect(() => {
    // Load local settings first
    const localKeys = localStorage.getItem('GEMINI_API_KEYS');
    if (localKeys) {
      try {
        const parsed = JSON.parse(localKeys);
        setApiKeys(parsed);
        setApiKeysInputText(parsed.join(', \n'));
      } catch(e) {}
    }
    
    const localUrls = localStorage.getItem('IMAGE_WORKER_URLS');
    if (localUrls) {
      const urlsArray = localUrls.split(',').filter(Boolean);
      setImageUrls(urlsArray);
      setImageUrlsInputText(urlsArray.join(', \n'));
    }

    const storedToken = localStorage.getItem('GITHUB_TOKEN');
    if (storedToken) {
      fetchUserData(storedToken);
    } else {
      setIsAuthLoading(false);
    }
  }, []);

  const handleLoginWithToken = async (e: FormEvent) => {
    e.preventDefault();
    if (!githubTokenInput) return;
    setIsAuthLoading(true);
    try {
      await fetchUserData(githubTokenInput);
    } catch(e) {
      setSaveStatus({ type: 'error', message: "Invalid GitHub Token or Missing Scopes" });
      setIsAuthLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('GITHUB_TOKEN');
    setGithubToken(null);
    setUser(null);
    setApiKeys([]);
    setImageUrls([]);
    setApiKeysInputText('');
    setImageUrlsInputText('');
    setSaveStatus({ type: 'idle', message: '' });
    setDbProjects([]);
  };

  const [scenes, setScenes] = useState<Scene[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const requestRef = useRef<number>(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const activeSceneIndex = useMemo(() => {
    let activeIdx = scenes.length - 1;
    for (let i = 0; i < scenes.length; i++) {
      if (currentTime >= scenes[i].timestamp && (i === scenes.length - 1 || currentTime < scenes[i + 1].timestamp)) {
        activeIdx = i;
        break;
      }
    }
    return Math.max(0, activeIdx);
  }, [currentTime, scenes]);

  useEffect(() => {
    if (stripRef.current && scenes.length > 0 && activeSceneIndex >= 0) {
      const activeChild = stripRef.current.children[activeSceneIndex] as HTMLElement;
      if (activeChild) {
        const strip = stripRef.current;
        const scrollLeft = activeChild.offsetLeft - (strip.clientWidth / 2) + (activeChild.clientWidth / 2);
        strip.scrollTo({ left: scrollLeft, behavior: 'smooth' });
      }
    }
  }, [activeSceneIndex, scenes.length]);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      const targetHeight = isFocused ? Math.max(120, scrollHeight) : scrollHeight;
      textareaRef.current.style.height = `${Math.min(targetHeight, 300)}px`;
    }
  };

  useEffect(() => {
    adjustHeight();
  }, [script, isFocused]);

  // Constants for 9:16 video
  const CANVAS_WIDTH = 1080;
  const CANVAS_HEIGHT = 1920;

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.onended = () => {
        setIsPlaying(false);
        setCurrentTime(0);
      };
      audioRef.current.ontimeupdate = () => {
        const time = audioRef.current?.currentTime || 0;
        setCurrentTime(time);
        
        // Sync timeline scroll
        if (timelineRef.current && duration > 0) {
          const scrollWidth = timelineRef.current.scrollWidth - timelineRef.current.clientWidth;
          timelineRef.current.scrollLeft = (time / duration) * scrollWidth;
        }
      };
    }
  }, [audioUrl, duration]);

  const generateVoiceover = async (targetScript: string): Promise<{duration: number, base64: string}> => {
    setStatus('Synthesizing voice...');
    const ttsResponse = await generateContentWithRetry({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: targetScript }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: selectedVoice }, 
          },
        },
      },
    }, apiKeys);

    const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
    if (!base64Audio) throw new Error("Voiceover failed.");

    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = pcmToWav(bytes, 24000);
    const tempUrl = URL.createObjectURL(blob);
    
    // We can still set audio url for local preview if needed
    setAudioUrl(tempUrl);

    const tempAudio = new Audio(tempUrl);
    await new Promise((resolve, reject) => {
      tempAudio.onloadedmetadata = () => {
        setDuration(tempAudio.duration);
        resolve(null);
      };
      tempAudio.onerror = () => reject(new Error("Audio load failed"));
    });
    
    // Actually we need to return the base64 of the WAV, not the raw PCM base64 returned by gemini
    // So we convert the blob to base64
    const wavBase64 = await blobToBase64(blob);

    return { duration: tempAudio.duration, base64: wavBase64 };
  };

  const createAtmosphere = (audioCtx: AudioContext, destination: AudioNode) => {
    return {
      stop: () => {
      }
    };
  };

  const [sourceNodeRefState, setSourceNodeRefState] = useState<any>(null); // just to track maybe? No we use ref
  
  const handlePlay = async () => {
    if (!audioRef.current) return;
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      if (!sourceNodeRef.current && audioRef.current) {
        try {
          sourceNodeRef.current = audioContextRef.current.createMediaElementSource(audioRef.current);
          sourceNodeRef.current.connect(audioContextRef.current.destination);
        } catch (e) {
          console.warn("Source already connected in handlePlay");
        }
      }

      const playPromise = audioRef.current.play();
      if (playPromise !== undefined) {
         await playPromise.catch(e => console.warn("play interrupted", e));
      }
      setIsPlaying(true);
      
      if (audioContextRef.current) {
        const atmosphere = createAtmosphere(audioContextRef.current, audioContextRef.current.destination);
        (window as any)._previewAtmosphere = atmosphere;
      }
    } catch (err) {
      console.error("Playback failed:", err);
    }
  };

  const handleStop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setCurrentTime(0);
    
    if ((window as any)._previewAtmosphere) {
      (window as any)._previewAtmosphere.stop();
      (window as any)._previewAtmosphere = null;
    }
  };

  useEffect(() => {
    if ((window as any).isHeadless && scenes.length > 0 && !isGenerating && !isPlaying && audioUrl) {
      handleStitchVideo();
    }
  }, [scenes, isGenerating, isPlaying, audioUrl]);

  const handleStitchVideo = async () => {
    if (scenes.length === 0 || !audioUrl) return;
    setStatus('Sending to server for high-speed FFmpeg stitching...');
    setProgress(0);
    
    try {
      // 1. Get audio as base64
      let audioBase64 = "";
      if (audioUrl.startsWith('data:audio/')) {
        audioBase64 = audioUrl.split(',')[1];
      } else {
        const audioRes = await fetch(audioUrl);
        const audioBlob = await audioRes.blob();
        audioBase64 = await (async () => {
          return new Promise<string>((resolve, _) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(audioBlob);
          });
        })();
      }

      // 2. Prepare scenes with calculated durations and clean URLs
      const processedScenes = await Promise.all(scenes.map(async (scene, i) => {
        const nextTimestamp = i < scenes.length - 1 ? scenes[i + 1].timestamp : duration;
        let imgFinal = scene.imageUrl;
        
        // Only convert blob: or local URLs to base64 to save upload size
        if (scene.imageUrl && scene.imageUrl.startsWith('blob:')) {
          try {
            const imgRes = await fetch(scene.imageUrl);
            const imgBlob = await imgRes.blob();
            const base64 = await (async () => {
              return new Promise<string>((resolve, _) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.readAsDataURL(imgBlob);
              });
            })();
            imgFinal = base64;
          } catch (e) {
            console.error(`Failed to convert image ${i} to base64`, e);
          }
        }

        return {
          imageUrl: imgFinal,
          duration: Math.max(0.1, nextTimestamp - scene.timestamp)
        };
      }));

      // 3. Send to backend
      const response = await fetch("/api/video/stitch", {
        method: "POST",
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          scenes: processedScenes,
          audioBase64: audioBase64.split(',')[1] || audioBase64 // stripped header if present
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Stitching failed");
      }

      const videoBlob = await response.blob();
      const videoUrl = URL.createObjectURL(videoBlob);
      
      const a = document.createElement("a");
      a.href = videoUrl;
      a.download = `video_stitch_${Date.now()}.mp4`;
      a.click();
      URL.revokeObjectURL(videoUrl);
      setStatus('Video generated successfully!');

    } catch (err: any) {
      console.error("Stitching error:", err);
      setError("Stitching failed: " + err.message);
      setStatus('Error during stitching');
    }
  };

  const isRecordingRef = useRef(false);
  const handleRecordVideo = async () => {
    if (!canvasRef.current || !audioUrl) return;
    if (isRecordingRef.current) return;
    isRecordingRef.current = true;
    
    try {
      await document.fonts.ready;
    } catch (e) {
      console.warn("Font pre-load readiness failed, proceeding anyway", e);
    }
    console.log("Starting high-quality recording (9:16)...");
    
    const canvas = canvasRef.current;
    // Force specific bitrates and 60fps for maximum quality
    const stream = canvas.captureStream(60);
    
    const audio = audioRef.current;
    if (!audio) return;
    
    if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const audioCtx = audioContextRef.current;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    
    if (!sourceNodeRef.current) {
        try {
            sourceNodeRef.current = audioCtx.createMediaElementSource(audio);
        } catch (e) {
            console.warn("Failed to create media element source in record:", e);
        }
    }
    const source = sourceNodeRef.current;
    if (source) {
       const dest = audioCtx.createMediaStreamDestination();
       source.connect(dest);
       source.connect(audioCtx.destination);
       dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    }

    let mimeType = 'video/webm;codecs=vp9,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/mp4'; // Safari fallback
      }
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : '',
      videoBitsPerSecond: 25000000 // 25Mbps for ultra quality
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      const actualMimeType = mimeType || '';
      const ext = actualMimeType.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: actualMimeType });
      (window as any)._finalVideoBlob = blob;
      console.log("Final video blob ready (9:16 aspect ratio confirmed)");
      
      if ((window as any).isHeadless) {
        console.log("In headless mode, directly downloading file for GitHub action...");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `preview.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
        setStatus('Render complete! Blob downloaded.');
        isRecordingRef.current = false;
        setTimeout(() => { (window as any)._renderComplete = true; }, 1000);
        return;
      }
      
      setStatus('Sending to backend to render exact preview to MP4. Please wait...');
      try {
        const formData = new FormData();
        formData.append("video", blob, `preview.${ext}`);
        
        const response = await fetch("/api/video/render", {
          method: "POST",
          body: formData
        });
        
        if (!response.ok) throw new Error("Render Failed");
        
        const mp4Blob = await response.blob();
        const url = URL.createObjectURL(mp4Blob);
        
        // Trigger download
        const a = document.createElement("a");
        a.href = url;
        a.download = `video_render_${Date.now()}.mp4`;
        a.click();
        URL.revokeObjectURL(url);
        
        setStatus('Ready!');
      } catch (err: any) {
        console.error("Backend render failed:", err);
        setStatus("MP4 conversion failed (or on Github pages), downloading WebM fallback instead...");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `video_render_${Date.now()}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
        setStatus(`Ready! (${ext.toUpperCase()} Fallback)`);
      } finally {
        isRecordingRef.current = false;
      }
    };

    recorder.start();
    audio.currentTime = 0;
    setTimeout(() => {
      handlePlay();
    }, 500); // Slight delay to ensure recorder is ready
    
    let stuckCount = 0;
    let expectedDuration = scenes.length > 0 ? scenes[scenes.length - 1].timestamp + 5 : 60;
    
    const checkEnd = setInterval(() => {
      // Sometimes audio.ended is not reliable or currentTime gets stuck near the end
      if (audio.ended || audio.currentTime >= (audio.duration || expectedDuration) - 0.1 || stuckCount > (expectedDuration * 10 + 50)) {
        clearInterval(checkEnd);
        if (recorder.state !== 'inactive') {
            recorder.stop();
        }
        handlePause();
        console.log("Recording stopped at end of audio.");
      }
      stuckCount++;
    }, 100);
  };

  const handlePause = () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
    
    if ((window as any)._previewAtmosphere) {
      (window as any)._previewAtmosphere.stop();
      (window as any)._previewAtmosphere = null;
    }
  };

  const togglePlay = () => {
    if (isPlaying) handlePause();
    else handlePlay();
  };
  const sanitizePrompt = (p: string) => {
    // Filter to remove words that heavily trigger NSFW filters (sexual, gore, etc.)
    // We allow artistic words like 'darkness', 'shadow', 'ominous' now as requested for the tone.
    const restricted = [
      'blood', 'gore', 'naked', 'sexual', 'porn', 'violence', 'death', 'kill', 'murder', 'suicide', 
      'genitals', 'breast', 'penis', 'vagina', 'abuse', 'hit', 'smash', 'crush', 'weapon', 
      'gun', 'knife', 'sharp', 'toxic', 'poison', 'harm', 'bleed', 'slay', 'dead', 'knife', 
      'cut', 'wound', 'suffering', 'agony'
    ];
    let sanitized = p.toLowerCase();
    restricted.forEach(word => {
      sanitized = sanitized.split(word).join('intense');
    });
    // Remove characters that might break prompts
    sanitized = sanitized.replace(/[^\w\s,]/gi, ' ');
    return sanitized.substring(0, 500); 
  };

  const generateImageFromProviders = async (prompt: string): Promise<Blob> => {
    let workerUrls = imageUrls;
    const storedUrls = typeof window !== 'undefined' ? localStorage.getItem('IMAGE_WORKER_URLS') : null;
    
    if (storedUrls) {
      try {
        if (storedUrls.startsWith('[')) {
          workerUrls = JSON.parse(storedUrls);
        } else {
          workerUrls = storedUrls.split(/[,\s\n]+/).map(u => u.trim()).filter(Boolean);
        }
      } catch (e) {
        workerUrls = storedUrls.split(/[,\s\n]+/).map(u => u.trim()).filter(Boolean);
      }
    }

    if (!workerUrls || workerUrls.length === 0) {
      workerUrls = [
        "https://flux1.shreevathsa2k27.workers.dev/",
        "https://flux.shreevathsa2k21-4fa.workers.dev/",
        "https://flux.vaishakhaphotos2.workers.dev/",
        "https://flux.vmajibail.workers.dev/"
      ];
    }

    const shuffledUrls = [...workerUrls].sort(() => Math.random() - 0.5);

    let lastError = null;

    for (const workerUrl of shuffledUrls) {
      try {
        console.log(`[Flux Proxy Frontend] Trying URL: ${workerUrl}`);
        const response = await fetch(workerUrl.trim(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[Flux Frontend Error] ${workerUrl}:`, response.status, errorText);
          
          if (response.status === 429 || response.status >= 500) {
            lastError = { status: response.status, text: errorText };
            continue;
          }
          throw new Error(errorText || `HTTP ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        let uintArray = new Uint8Array(arrayBuffer);

        if (uintArray[0] === 123) {
          const textData = new TextDecoder("utf-8").decode(uintArray);
          try {
            const json = JSON.parse(textData);
            const b64 = json.image || json.result?.image || json.img;
            if (b64) {
              const base64Data = b64.replace(/^data:image\/\w+;base64,/, "");
              const binStr = atob(base64Data);
              const binArr = new Uint8Array(binStr.length);
              for (let i = 0; i < binStr.length; i++) {
                binArr[i] = binStr.charCodeAt(i);
              }
              return new Blob([binArr], { type: "image/jpeg" });
            }
          } catch (e) {
            console.error("JSON parse failed", e);
          }
        }
        
        return new Blob([arrayBuffer], { type: "image/jpeg" });

      } catch (error: any) {
        console.error(`[Flux Proxy Exception] ${workerUrl}:`, error.message);
        lastError = { status: 500, text: error.message };
        continue;
      }
    }

    try {
      console.log(`[Flux Frontend] Using Pollinations fallback`);
      const response = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=720&height=1280&nologo=true`, {
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return new Blob([arrayBuffer], { type: "image/jpeg" });
      }
    } catch (e) {
      console.error("[Flux Proxy] Pollinations fallback failed:", e);
    }

    throw new Error(lastError?.text || "All workers failed");
  };

  const regenerateImage = async (index: number) => {
    const scene = scenes[index];
    if (!scene) return;

    setRegeneratingIdx(index);
    setStatus(`Updating frame ${index + 1}...`);
    
    let attempts = 0;
    let success = false;
    let lastErr = '';

    while (attempts < 3 && !success) {
      try {
        const sanitizedScenePrompt = sanitizePrompt(scene.prompt);
        const fullPrompt = `Deeply dark psychological anime/manga style, heart-touching human vulnerability, cinematic composition, ${sanitizedScenePrompt}, masterpiece, high quality, expressive shadows, soulful atmosphere, no text.`;
        const blob = await generateImageFromProviders(fullPrompt);
        const url = URL.createObjectURL(blob);
        
        setScenes(prev => {
          const next = [...prev];
          if (next[index].imageUrl) URL.revokeObjectURL(next[index].imageUrl!);
          next[index] = { ...next[index], imageUrl: url };
          return next;
        });
        setStatus('Frame updated');
        success = true;
      } catch (err: any) {
        attempts++;
        lastErr = err.message;
        console.warn(`Attempt ${attempts} failed for scene ${index}:`, err);
        setStatus(`Retrying frame ${index + 1} (${attempts}/3)...`);
      }
    }

    if (!success) {
      setError(`Failed to regenerate after 3 attempts: ${lastErr}`);
    }
    setRegeneratingIdx(null);
  };

  const [activeJobId, setActiveJobId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('lastActiveJobId');
    }
    return null;
  });

  useEffect(() => {
    if (activeJobId) {
      localStorage.setItem('lastActiveJobId', activeJobId);
    } else {
      localStorage.removeItem('lastActiveJobId');
    }
  }, [activeJobId]);

  useEffect(() => {
    let intv: any;
    let failCount = 0;
    if (activeJobId) {
      intv = setInterval(async () => {
        try {
          const res = await fetch(`/api/job/${activeJobId}`);
          if (!res.ok) {
             throw new Error("Job missing");
          }
          const job = await res.json();
          failCount = 0; // reset on success
          setProgress(job.progress);
          
          if (job.status === 'idle') setStatus('Initializing backend generation...');
          else if (job.status === 'generating_voice') setStatus('Synthesizing voice...');
          else if (job.status === 'planning') setStatus(`Plan created, Audio Duration: ${job.duration?.toFixed(1)}s. Planning visual scenes...`);
          else if (job.status === 'generating_images') setStatus('Generating images with Cloudflare SD workers...');
          else if (job.status === 'stitching') setStatus('Stitching video frames and audio rapidly via FFmpeg...');
          else if (job.status === 'uploading') setStatus('Uploading MP4 to your GitHub Releases...');
          else if (job.status === 'completed') {
             setStatus(`Success! Project saved securely in your GitHub Releases.`);
             if (job.scenes && job.scenes.length > 0) {
               setScenes(job.scenes);
             }
             if (job.audioBase64) {
               setAudioUrl(`data:audio/wav;base64,${job.audioBase64}`);
               setDuration(job.duration || 0);
             }
             
             // Update dbProjects
             setDbProjects(prev => prev.map(p => 
               p.id === activeJobId
                 ? { ...p, status: 'ready', videoUrl: job.videoUrl }
                 : p
             ));

             setIsGenerating(false);
             setActiveJobId(null);
          } else if (job.status === 'failed') {
             setError(job.error || "Backend job failed");
             setStatus("");
             setIsGenerating(false);
             setActiveJobId(null);
          }

        } catch(e) {
             console.error("Job check failed", e);
             failCount++;
             if (failCount > 3) {
                 setError("Lost connection to backend job. The server might have restarted, please try again.");
                 setIsGenerating(false);
                 setActiveJobId(null);
             }
        }
      }, 2000);
    }
    return () => clearInterval(intv);
  }, [activeJobId, audioUrl]);

  const generateFullVideo = async (providedScript?: string) => {
    const textToUse = providedScript || script;
    if (!textToUse.trim()) {
      setError('Enter a script first.');
      return;
    }

    setOriginalScript(textToUse);
    setScript('');
    setShowInputBar(false);
    setIsGenerating(true);
    setError(null);
    setProgress(0);
    setScenes([]);
    setAudioUrl(null);
    setStatus('Dispatching task to backend...');

    setSelectedProjectId(null);

    try {
      const payload = {
        script: textToUse,
        apiKeys: apiKeys,
        imageWorkers: imageUrls,
        githubToken: githubToken || "",
        voice: selectedVoice
      };

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Failed to start background job");
      }

      const { jobId } = await res.json();
      
      // We no longer set activeJobId here. We let the background polling handle all rendering jobs.
      // We set activeJobId so it polls, but we clear selectedProjectId so the user is in a blank chat.
      setActiveJobId(jobId);
      
      // Inject optimistic local project into history (prepended to top)
      setDbProjects(prev => {
        const prevItems = prev || [];
        const newProj: Project = { id: jobId, status: 'rendering', script: textToUse, userId: user?.id?.toString() || '0', createdAt: new Date() };
        return [newProj, ...prevItems];
      });

      // Clear the UI so it looks like a new empty chat that they can use immediately
      setScript('');
      setOriginalScript('');
      setSelectedProjectId(null);
      setIsGenerating(false);

    } catch (err: any) {
      setError(err.message || 'Workflow error');
      setIsGenerating(false);
    }
  };

  const imageElementRef = useRef<HTMLImageElement | null>(null);
  const particlesRef = useRef<CinematicParticle[]>([]);

  // Initialize particles once
  const initParticles = () => {
    const particles: CinematicParticle[] = [];
    
    // Shadow Particles
    for (let i = 0; i < 20; i++) {
      particles.push({
        x: Math.random() * 720,
        y: Math.random() * 1280,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        size: 1 + Math.random() * 3,
        life: Math.random() * 100,
        maxLife: 200 + Math.random() * 200,
        opacity: 0,
        type: 'shadow'
      });
    }

    // Fire Embers (Increased count and brightness)
    for (let i = 0; i < 45; i++) {
      particles.push({
        x: Math.random() * 720,
        y: 1280 + Math.random() * 200,
        vx: (Math.random() - 0.5) * 3.0, 
        vy: -3.0 - Math.random() * 5.0, 
        size: 0.4 + Math.random() * 1.2, 
        life: 0,
        maxLife: 250 + Math.random() * 400,
        opacity: 0,
        type: 'ember',
        color: Math.random() > 0.4 ? '#ffcc00' : (Math.random() > 0.5 ? '#ff6600' : '#ffffff')
      });
    }

    // Smoke Wisps (Reduced count for less clutter)
    for (let i = 0; i < 22; i++) {
      particles.push({
        x: Math.random() * 720,
        y: 1280 + Math.random() * 500,
        vx: (Math.random() - 0.5) * 0.8,
        vy: -1.0 - Math.random() * 1.8, 
        size: 50 + Math.random() * 120, 
        life: 0,
        maxLife: 600 + Math.random() * 1000,
        opacity: 0,
        type: 'smoke',
        rotation: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.008 
      });
    }

    particlesRef.current = particles;
  };

  const pcmToWav = (pcmData: Uint8Array, sampleRate: number = 24000) => {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmData.length;
    const totalSize = 44 + dataSize;
    const arrayBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(arrayBuffer);
    view.setUint32(0, 0x52494646, false);
    view.setUint32(4, totalSize - 8, true);
    view.setUint32(8, 0x57415645, false);
    view.setUint32(12, 0x666d7420, false);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    view.setUint32(36, 0x64617461, false);
    view.setUint32(40, dataSize, true);
    new Uint8Array(arrayBuffer, 44).set(pcmData);
    return new Blob([arrayBuffer], { type: 'audio/wav' });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!imageElementRef.current) imageElementRef.current = new Image();
    const img = imageElementRef.current;
    
    // Ensure particles are initialized
    if (particlesRef.current.length === 0) initParticles();

    const render = (time: number) => {
      if (!ctx || scenes.length === 0) return;
      
      const audioTime = audioRef.current?.currentTime || 0;
      const SCENE_DURATION = 5;
      const localTime = audioTime % SCENE_DURATION;
      
      // Find the correct scene for the current time
      let sceneIndex = 0;
      for (let i = scenes.length - 1; i >= 0; i--) {
        if (scenes[i].timestamp <= audioTime) {
          sceneIndex = i;
          break;
        }
      }
      const currentScene = scenes[sceneIndex];
      if (!currentScene) return; // double check

      const sceneStart = currentScene.timestamp;
      const nextScene = scenes[sceneIndex + 1];
      const sceneEnd = nextScene ? nextScene.timestamp : duration;
      const sceneDuration = Math.max(0.1, sceneEnd - sceneStart);
      const progressInScene = Math.max(0, Math.min(1, (audioTime - sceneStart) / sceneDuration));

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      if (currentScene?.imageUrl) {
        if (img.src !== currentScene.imageUrl) img.src = currentScene.imageUrl;
        if (img.complete && img.naturalWidth !== 0) {
          const shakeX = Math.sin(time / 150) * 1.5;
          const shakeY = Math.cos(time / 180) * 1.5;
          
          // Alternating 10% Zoom Effect (Ken Burns)
          const isZoomIn = sceneIndex % 2 === 0;
          const zoomAmount = 0.10;
          const zoomScale = isZoomIn 
            ? (1.0 + progressInScene * zoomAmount) 
            : (1.0 + zoomAmount - progressInScene * zoomAmount);

          ctx.save();
          ctx.globalAlpha = 1.0; 
          
          ctx.translate(CANVAS_WIDTH / 2 + shakeX, CANVAS_HEIGHT / 2 + shakeY);
          ctx.scale(zoomScale, zoomScale);
          const imgAspect = img.naturalWidth / img.naturalHeight;
          const canvasAspect = CANVAS_WIDTH / CANVAS_HEIGHT;
          let drawW, drawH;
          if (imgAspect > canvasAspect) {
            drawH = CANVAS_HEIGHT;
            drawW = CANVAS_HEIGHT * imgAspect;
          } else {
            drawW = CANVAS_WIDTH;
            drawH = CANVAS_WIDTH / imgAspect;
          }
          ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
          ctx.restore();
          const gradient = ctx.createRadialGradient(CANVAS_WIDTH/2, CANVAS_HEIGHT/2, 0, CANVAS_WIDTH/2, CANVAS_HEIGHT/2, CANVAS_HEIGHT/1.1);
          gradient.addColorStop(0, 'transparent');
          gradient.addColorStop(0.7, 'rgba(0,0,0,0.2)');
          gradient.addColorStop(1, 'rgba(0,0,0,0.8)');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          
          // Persistent Cinematic Noise Grain
          ctx.save();
          ctx.globalAlpha = 0.12; 
          for(let i=0; i<3500; i++) {
            const gx = Math.random() * CANVAS_WIDTH;
            const gy = Math.random() * CANVAS_HEIGHT;
            const intensity = Math.random() * 255;
            ctx.fillStyle = `rgb(${intensity}, ${intensity}, ${intensity})`;
            ctx.fillRect(gx, gy, 1.2, 1.2);
          }
          ctx.restore();
        }
      } 

      // Cinematic Particles Overlay (Shadows, Embers, Smoke)
      ctx.save();
      particlesRef.current.forEach(p => {
        // Advanced Physics: Add slight turbulence/air current
        if (p.type === 'smoke' || p.type === 'ember') {
          // Add random jitter to velocity - scaled down for smoothness
          p.vx += (Math.random() - 0.5) * 0.15; 
          p.vy += (Math.random() - 0.5) * 0.05; 
          
          // Air resistance / capping
          p.vx *= 0.98;
          
          if (p.rotation !== undefined && p.vr !== undefined) {
             p.rotation += p.vr;
          }
        }

        // Use more varied frequency for sway to avoid "circular" look
        const swayFreq = p.type === 'smoke' ? (2000 + (p.x % 1000)) : 1000;
        const swayAmp = p.type === 'smoke' ? 0.8 : 0.4;
        p.x += p.vx + Math.sin(time / swayFreq + (p.life * 0.02)) * swayAmp;
        p.y += p.vy;
        p.life++;

        // Smoke expands as it rises
        if (p.type === 'smoke') {
          p.size += 0.25; // Continuous expansion
        }

        // Opacity mapping for smooth fade in/out
        if (p.life < p.maxLife * 0.15) {
          p.opacity = p.life / (p.maxLife * 0.15);
        } else if (p.life > p.maxLife * 0.7) {
          p.opacity = 1 - (p.life - p.maxLife * 0.7) / (p.maxLife * 0.3);
        } else {
          p.opacity = 1;
        }

        // Realistic vertical fade: disappears as it moves to the top
        const verticalFade = Math.max(0, Math.min(1, (p.y + p.size) / (CANVAS_HEIGHT * 0.9)));

        // Render based on type
        if (p.opacity > 0) {
          if (p.type === 'shadow') {
            ctx.fillStyle = `rgba(0, 0, 0, ${p.opacity * 0.4})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
          } else if (p.type === 'ember') {
            const flicker = 0.7 + Math.random() * 0.3;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter'; // Makes embers pop
            ctx.shadowBlur = 12; 
            ctx.shadowColor = p.color || '#ff9d00';
            ctx.fillStyle = p.color || '#ff9d00';
            ctx.globalAlpha = p.opacity * flicker * 0.9 * verticalFade; 
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          } else if (p.type === 'smoke') {
            ctx.save();
            ctx.translate(p.x, p.y);
            if (p.rotation) ctx.rotate(p.rotation);
            
            // Very low base opacity for smoke to allow stacking (50% reduction from previous)
            const smokeOpacity = p.opacity * 0.035 * verticalFade;
            
            // Single, ultra-soft radial gradient for a "mist" look
            const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size);
            grad.addColorStop(0, `rgba(220, 220, 220, ${smokeOpacity})`);
            grad.addColorStop(0.3, `rgba(200, 200, 200, ${smokeOpacity * 0.6})`);
            grad.addColorStop(0.6, `rgba(180, 180, 180, ${smokeOpacity * 0.2})`);
            grad.addColorStop(1, 'rgba(150, 150, 150, 0)');
            
            ctx.fillStyle = grad;
            ctx.beginPath();
            // Stretched ellipse for more organic shape
            ctx.ellipse(0, 0, p.size, p.size * 0.6, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }

        // Recycle particles with randomized restart
        if (p.life >= p.maxLife || p.y < -500 || p.x < -300 || p.x > CANVAS_WIDTH + 300) {
          p.x = Math.random() * CANVAS_WIDTH;
          p.y = CANVAS_HEIGHT + 100 + Math.random() * 400;
          p.life = 0;
          p.opacity = 0;
          p.vx = (Math.random() - 0.5) * (p.type === 'ember' ? 2.5 : 1.0);
          if (p.type === 'smoke') p.size = 80 + Math.random() * 200;
        }
      });
      ctx.restore();

      // Subtle Glitch Effect
      const glitchSeed = Math.random();
      if (glitchSeed < 0.05 && audioTime > 0 && isPlaying) {
        ctx.save();
        const sliceY = Math.random() * CANVAS_HEIGHT;
        const sliceH = 5 + Math.random() * 40;
        const sliceX = (Math.random() - 0.5) * 10;
        
        // Horizontal slice shift
        ctx.drawImage(canvas, 0, sliceY, CANVAS_WIDTH, sliceH, sliceX, sliceY, CANVAS_WIDTH, sliceH);
        
        // Occasional color aberration
        if (glitchSeed < 0.02) {
          ctx.globalAlpha = 0.2;
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = '#ff0000';
          ctx.fillRect(0, sliceY, CANVAS_WIDTH, 2);
          ctx.fillStyle = '#00ffff';
          ctx.fillRect(0, sliceY + 4, CANVAS_WIDTH, 2);
        }
        ctx.restore();
      }

      // Subtitles - Centered Single Line with Character Chunking
      if (currentScene?.text) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const fullText = currentScene.text.trim();
        const words = fullText.split(/\s+/);
        const WORDS_PER_CHUNK = 4; // 3-4 words per chunk
        
        // Chunking by words
        const chunks: string[] = [];
        for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
          chunks.push(words.slice(i, i + WORDS_PER_CHUNK).join(' '));
        }
        
        // Calculate which chunk to show based on word count progress for better word-to-voice matching
        const currentWordIdx = Math.floor(progressInScene * words.length);
        const chunkIndex = Math.min(Math.floor(currentWordIdx / WORDS_PER_CHUNK), chunks.length - 1);
        let chunkText = (chunks[chunkIndex] || "").trim();

        // Preserve original capitalization and punctuation from the AI-generated text, 
        // just ensure it doesn't look like a mid-sentence fragment if possible.
        if (chunkText.length > 0 && /^[a-z]/.test(chunkText)) {
          chunkText = chunkText.charAt(0).toUpperCase() + chunkText.slice(1);
        }

        ctx.font = 'bold 84px "Dancing Script", cursive';
        
        const x = CANVAS_WIDTH / 2;
        const y = CANVAS_HEIGHT * 0.75; 
        const lineHeight = 110; 

        // Split words to handle line-breaking for chunks of 4 words
        const chunkWords = chunkText.split(' ');
        const displayLines: string[] = [];
        
        if (chunkWords.length >= 4) {
          // Exactly 4 words or more: split into two lines for readability
          displayLines.push(chunkWords.slice(0, 2).join(' '));
          displayLines.push(chunkWords.slice(2).join(' '));
        } else {
          displayLines.push(chunkText);
        }
        
        displayLines.forEach((line, index) => {
          // Calculate individual line Y to keep the block centered around 'y'
          const lineY = y + (index - (displayLines.length - 1) / 2) * lineHeight;

          // Intense Dark Glow Outline
          ctx.save();
          ctx.shadowColor = 'rgba(0, 0, 0, 1)';
          ctx.shadowBlur = 35;
          ctx.lineWidth = 14;
          ctx.strokeStyle = '#000000';
          ctx.strokeText(line, x, lineY);
          ctx.restore();

          // Subtitle Text (Strong Yellow/Orange gradient for luxury feel)
          const textGrad = ctx.createLinearGradient(x, lineY - 40, x, lineY + 40);
          textGrad.addColorStop(0, '#FFFFFF');
          textGrad.addColorStop(1, '#ffc400');
          ctx.fillStyle = textGrad;
          ctx.fillText(line, x, lineY);
        });

        ctx.restore();
      }

      if (isGenerating) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0,0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.fillStyle = '#f97316';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('GENERATING VISION...', CANVAS_WIDTH/2, CANVAS_HEIGHT/2);
      }

      requestRef.current = requestAnimationFrame(render);
    };
    requestRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(requestRef.current);
  }, [scenes, currentTime, isGenerating]);

  return (
    <div className="h-[100dvh] flex bg-[#050505] text-zinc-200 font-sans overflow-hidden">
      <audio ref={audioRef} src={audioUrl || undefined} />

      {/* Sidebar Overlay for Mobile */}
      <AnimatePresence>
        {isMobile && isSidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <AnimatePresence mode="wait">
        {isSidebarOpen && (
          <motion.div 
            initial={isMobile ? { x: '-100%' } : { width: 0, opacity: 0 }}
            animate={isMobile ? { x: 0 } : { width: 260, opacity: 1 }}
            exit={isMobile ? { x: '-100%' } : { width: 0, opacity: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 150 }}
            className={`flex-shrink-0 bg-zinc-950 border-r border-zinc-800/50 flex flex-col h-full z-[110] overflow-hidden ${isMobile ? 'fixed inset-y-0 left-0 w-[280px]' : 'relative'}`}
          >
            <div className="p-3 flex items-center justify-between">
              <button 
                onClick={() => {
                  setOriginalScript('');
                  setScript('');
                  setScenes([]);
                  setAudioUrl(null);
                  setCurrentTime(0);
                  setIsGenerating(false);
                  setShowInputBar(true);
                  setSelectedProjectId(null);
                  if (isMobile) setIsSidebarOpen(false);
                }}
                className="flex-1 flex justify-between items-center gap-2 bg-transparent hover:bg-zinc-900 border border-zinc-800 text-zinc-300 px-3 py-2 rounded-lg text-sm transition-colors mr-2"
               >
                 <span className="font-bold">New Video</span>
                 <PenTool size={14} className="text-orange-500" />
              </button>
              {isMobile && (
                 <button onClick={() => setIsSidebarOpen(false)} className="p-2 text-zinc-500 hover:text-white">
                   ✕
                 </button>
              )}
            </div>
            
            <div className="flex-1 overflow-y-auto custom-scrollbar px-2 space-y-1">
               <div className="text-xs font-bold text-zinc-600 px-2 my-2 uppercase tracking-wider">History</div>
               {dbProjects.length === 0 && (
                  <div className="text-xs text-zinc-500 px-2 italic">Nothing here yet...</div>
               )}
               {dbProjects.map((p) => (
                  <div key={p.id} className={`w-full text-left bg-transparent ${selectedProjectId === p.id ? 'bg-zinc-900 border-zinc-800 ring-1 ring-orange-500/20' : 'hover:bg-zinc-900/50 border-transparent'} border p-2.5 rounded-lg transition-all flex items-center justify-between group cursor-pointer`} onClick={() => {
                      setSelectedProjectId(p.id);
                      if (isMobile) setIsSidebarOpen(false);
                  }}>
                    <div className="flex flex-col truncate pr-2 flex-1">
                       {editingProjectId === p.id ? (
                         <input
                           autoFocus
                           className="bg-zinc-950 border border-orange-500/50 text-white text-sm px-1.5 py-0.5 rounded outline-none w-full shadow-inner"
                           value={editingTitle}
                           onChange={(e) => setEditingTitle(e.target.value)}
                           onBlur={() => {
                             if (editingTitle.trim()) {
                               setDbProjects(prev => prev.map(proj => proj.id === p.id ? { ...proj, script: editingTitle } : proj));
                             }
                             setEditingProjectId(null);
                           }}
                           onKeyDown={(e) => {
                             if (e.key === 'Enter') {
                               if (editingTitle.trim()) {
                                 setDbProjects(prev => prev.map(proj => proj.id === p.id ? { ...proj, script: editingTitle } : proj));
                               }
                               setEditingProjectId(null);
                             }
                             if (e.key === 'Escape') setEditingProjectId(null);
                           }}
                           onClick={(e) => e.stopPropagation()}
                         />
                       ) : (
                         <>
                           <span className="text-sm text-zinc-300 truncate font-medium">
                             {p.script.startsWith('Project ') ? `Video ${p.id.slice(-4)}` : p.script}
                           </span>
                           <span className="text-[10px] flex items-center gap-1 mt-1 font-mono uppercase tracking-tighter">
                              {p.status === 'rendering' ? (
                                <span className="text-orange-500 flex items-center gap-1">
                                  <Loader2 size={10} className="animate-spin" />
                                  {p.id === activeJobId && progress > 0 ? `RENDERING ${progress.toFixed(0)}%` : 'SYNCING'}
                                </span>
                              ) : (
                                <span className="text-emerald-500/70 flex items-center gap-1"><Video size={10} /> Ready</span>
                              )}
                           </span>
                         </>
                       )}
                    </div>
                    {!editingProjectId && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingProjectId(p.id);
                          setEditingTitle(p.script.startsWith('Project ') ? `Video ${p.id.slice(-4)}` : p.script);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 hover:text-orange-500 text-zinc-600 transition-all rounded hover:bg-white/5"
                      >
                        <PenTool size={12} />
                      </button>
                    )}
                  </div>
               ))}
            </div>

            <div className="p-3 border-t border-zinc-800/50">
               <button 
                 onClick={() => {
                   setShowSettings(!showSettings);
                   if (isMobile) setIsSidebarOpen(false);
                 }}
                 className="flex items-center gap-2 text-zinc-400 hover:text-zinc-200 text-sm w-full p-2.5 rounded-lg hover:bg-zinc-900 transition-colors"
               >
                 <Settings size={16} />
                 Settings
               </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header Bar */}
        <header className="shrink-0 h-14 border-b border-zinc-800/50 px-4 flex items-center justify-between bg-zinc-950 z-30">
          <div className="flex items-center gap-3">
            <AnimatePresence>
              {!isSidebarOpen && (
                <motion.button 
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  onClick={() => setIsSidebarOpen(true)} 
                  className="p-2 text-zinc-400 hover:text-white transition-colors bg-zinc-900/50 rounded-lg border border-zinc-800"
                >
                  <Menu size={18} />
                </motion.button>
              )}
            </AnimatePresence>
            
            <div className="w-6 h-6 bg-orange-500 rounded flex items-center justify-center shadow-lg shadow-orange-500/20">
              <Video size={14} className="text-black" />
            </div>
            <h1 className="text-[10px] font-bold uppercase tracking-[0.2em] hidden sm:block">Flux <span className="text-orange-500 text-opacity-80">Video Studio</span></h1>
          </div>

          <div className="flex items-center gap-3">
             {selectedProjectId !== activeJobId && scenes.length > 0 && !isPlaying && dbProjects.find(p => p.id === selectedProjectId)?.status !== 'rendering' && (
               <button
                 onClick={() => {
                   if (window.confirm("This will use server-side FFmpeg to stitch your scenes into a high-quality video instantly. Proceed?")) {
                     handleStitchVideo();
                   }
                 }}
                 className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-black text-xs font-bold px-3 py-1.5 rounded-lg transition-transform hover:scale-105 shadow-[0_0_10px_rgba(249,115,22,0.3)] whitespace-nowrap"
               >
                 <Video size={14} />
                 Stitch to MP4 (Fast)
               </button>
             )}

             {selectedProjectId && dbProjects.find(p => p.id === selectedProjectId) && (
               (dbProjects.find(p => p.id === selectedProjectId)?.status === 'ready' && selectedProjectId !== activeJobId) ? (
                 <button 
                   onClick={() => {
                     const url = dbProjects.find(p => p.id === selectedProjectId)?.videoUrl;
                     if (url) window.open(url, '_blank');
                   }}
                   className="hidden sm:flex items-center gap-2 border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-bold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                 >
                   <Download size={14} />
                   Get Actions MP4
                 </button>
               ) : (
                 <button 
                   disabled
                   className="flex items-center gap-2 border border-orange-500/50 text-orange-500 text-xs font-bold px-3 py-1.5 rounded-lg transition-transform opacity-70"
                 >
                   <Loader2 size={14} className="animate-spin" />
                   {selectedProjectId === activeJobId && progress > 0 ? `Rendering ${progress.toFixed(0)}%...` : `Rendering on Cloud...`}
                 </button>
               )
             )}

            {selectedProjectId === activeJobId && (
               <div className="hidden sm:flex items-center gap-3 w-24">
                <div className="h-1 w-full bg-zinc-900 rounded-full overflow-hidden">
                  <motion.div className="h-full bg-orange-500" animate={{ width: `${progress}%` }} />
                </div>
               </div>
            )}
            
            <div className="text-[10px] font-mono text-zinc-500 bg-zinc-900/50 px-2 py-1 rounded-full border border-zinc-800/50 max-w-[200px] truncate">
              {status || 'Idle'}
            </div>
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 flex flex-col items-center justify-center min-h-0 relative p-2 sm:px-4 sm:py-2 gap-2 w-full max-w-2xl mx-auto">

        
        <div className="relative flex-1 w-full min-h-0 bg-zinc-950 border border-white/5 rounded-2xl overflow-hidden shadow-2xl flex items-center justify-center group/player">
            <canvas 
              ref={canvasRef} 
              width={CANVAS_WIDTH} 
              height={CANVAS_HEIGHT} 
              className={`h-full w-full object-contain cursor-pointer transition-opacity duration-700 ${scenes.length > 0 ? 'opacity-100' : 'opacity-0'}`}
              onClick={() => {
                if (audioUrl) {
                  isPlaying ? handlePause() : handlePlay();
                }
              }}
            />

            {scenes.length === 0 && selectedProjectId !== activeJobId && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-zinc-950/50">
                <div className="w-20 h-20 bg-orange-500/10 rounded-full flex items-center justify-center mb-6 ring-1 ring-orange-500/20">
                  <Sparkles size={32} className="text-orange-500 animate-pulse" />
                </div>
                <h2 className="text-2xl font-cursive text-white mb-3">Begin Your Story</h2>
                <p className="text-zinc-400 text-sm max-w-[280px] leading-relaxed">
                  Enter an emotional script below to generate an anime-style cinematic video with AI voiceover.
                </p>
                <div className="mt-8 flex gap-2">
                   <div className="px-3 py-1 bg-zinc-900 border border-zinc-800 rounded text-[10px] text-zinc-500">Flux Image Engine</div>
                   <div className="px-3 py-1 bg-zinc-900 border border-zinc-800 rounded text-[10px] text-zinc-500">Gemini TTS</div>
                </div>
              </div>
            )}
            
            {selectedProjectId === activeJobId && scenes.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950">
                <div className="relative mb-6">
                  <Loader2 size={48} className="text-orange-500 animate-spin" />
                  <div className="absolute inset-0 blur-xl bg-orange-500/20 animate-pulse" />
                </div>
                <h3 className="text-sm font-bold uppercase tracking-widest text-orange-500/80 mb-2">
                  Crafting Vision <span className="text-white ml-2">{progress.toFixed(0)}%</span>
                </h3>
                <div className="w-48 h-1.5 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
                  <motion.div 
                    className="h-full bg-orange-500" 
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }} 
                  />
                </div>
                <p className="mt-4 text-[10px] font-mono text-zinc-500 max-w-sm text-center px-4">{status}</p>
              </div>
            )}

            {!isPlaying && audioUrl && scenes.length > 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] pointer-events-none group-hover/player:opacity-0 transition-opacity">
                <div className="w-16 h-16 bg-white/10 backdrop-blur-md border border-white/20 text-white rounded-full shadow-2xl flex items-center justify-center transition-all bg-opacity-80 scale-100 hover:scale-110">
                  <Play size={24} fill="currentColor" className="ml-1" />
                </div>
              </div>
            )}

            {/* In-video Regenerate Button */}
            {!isPlaying && scenes.length > 0 && activeSceneIndex >= 0 && (
              <div className="absolute top-4 left-4 z-50">
                <button 
                  disabled={regeneratingIdx === activeSceneIndex}
                  onClick={(e) => { e.stopPropagation(); regenerateImage(activeSceneIndex); }}
                  className="bg-black/60 hover:bg-orange-500 text-white p-2 rounded-full backdrop-blur-md transition-all shadow-xl border border-white/10 group flex items-center gap-2"
                  title="Regenerate this specific frame"
                >
                   <RefreshCw size={16} className={regeneratingIdx === activeSceneIndex ? "animate-spin text-orange-500" : "text-zinc-300 group-hover:text-white"} />
                   <span className="text-xs font-bold shrink-0 hidden group-hover:block pr-1">Regenerate Frame</span>
                </button>
              </div>
            )}

            {/* Over-video controls */}
            {audioUrl && (
              <div className="absolute left-0 right-0 bottom-0 p-3 pt-8 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex flex-col gap-2 opacity-0 group-hover/player:opacity-100 transition-opacity duration-300">
                <div className="w-full flex flex-col gap-2">
                  <div className="flex items-center justify-between px-1">
                    <button onClick={togglePlay} className="text-white hover:text-orange-500 transition-colors drop-shadow-md">
                      {isPlaying ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}
                    </button>
                    <span className="text-[10px] font-mono text-zinc-200 drop-shadow-md">{currentTime.toFixed(1)}s / {duration.toFixed(1)}s</span>
                  </div>
                  
                  <div className="relative w-full h-4 flex items-center group">
                    <div 
                      className="absolute top-1/2 -translate-y-1/2 left-0 h-1.5 bg-orange-500 rounded-full pointer-events-none shadow-[0_0_10px_rgba(249,115,22,0.8)] z-10" 
                      style={{ width: `${(currentTime / (duration || 1)) * 100}%` }} 
                    />
                    <input 
                      type="range" 
                      min={0} 
                      step="any"
                      max={duration || 100} 
                      value={currentTime} 
                      onChange={(e) => {
                        const newTime = parseFloat(e.target.value);
                        if (audioRef.current) {
                          audioRef.current.currentTime = newTime;
                          setCurrentTime(newTime);
                        }
                      }}
                      className="absolute w-full h-1.5 bg-white/20 backdrop-blur-sm rounded-full appearance-none flex cursor-pointer focus:outline-none m-0 hover:[&::-webkit-slider-thumb]:scale-125
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:z-20 [&::-webkit-slider-thumb]:transition-transform"
                    />
                  </div>
                </div>
              </div>
            )}
        </div>
        
        {/* Settings Overlay Sidebar */}
        <AnimatePresence>
          {showSettings && (
            <>
              {/* Backdrop */}
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/60 z-[60] backdrop-blur-sm"
                onClick={() => setShowSettings(false)}
              />
              <motion.div 
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="fixed top-0 right-0 bottom-0 w-72 bg-zinc-950 border-l border-zinc-800 shadow-2xl z-[70] flex flex-col"
              >
                <div className="h-14 border-b border-zinc-800/50 px-5 flex items-center justify-between shrink-0">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Settings</span>
                  <button onClick={() => setShowSettings(false)} className="p-2 -mr-2 text-zinc-500 hover:text-white rounded-lg hover:bg-zinc-900 transition-colors">
                    ✕
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-5 space-y-6">
                  <div>
                    <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3 block">Voice Model</label>
                    <div className="relative group">
                      <select
                        value={selectedVoice}
                        onChange={(e) => setSelectedVoice(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-[12px] outline-none text-zinc-300 appearance-none cursor-pointer focus:border-orange-500/50 transition-all"
                      >
                        {VOICES.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                      <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-600 group-focus-within:text-orange-500 transition-colors">
                        <Volume2 size={14} />
                      </div>
                    </div>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-[9px] text-zinc-500">
                      <span className="uppercase font-bold tracking-widest">Engine Configuration</span>
                    </div>
                    <div className="bg-zinc-900/50 rounded-xl p-3 text-[11px] font-mono text-zinc-400 space-y-2 border border-zinc-800/50">
                      <div className="flex justify-between p-1 bg-black/20 rounded">
                         <span>TTS Core:</span> <span className="text-orange-500 opacity-80">Flash TTS</span>
                      </div>
                      <div className="flex justify-between p-1 bg-black/20 rounded">
                         <span>Aspect:</span> <span>9:16 (Vertical)</span>
                      </div>
                      <div className="flex justify-between p-1 bg-black/20 rounded">
                         <span>Render:</span> <span>720x1280 px</span>
                      </div>
                      <div className="flex justify-between p-1 bg-black/20 rounded">
                         <span>Format:</span> <span>WebM/VP9+Opus</span>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </main>

      {/* Bottom controls container */}
      <div className="shrink-0 flex flex-col w-full relative z-30 bg-zinc-950 border-t border-zinc-800/50">
        
        {/* Larger strip of images preview */}
        {scenes.length > 0 && (
          <div 
            ref={stripRef}
            className="h-40 sm:h-52 w-full overflow-x-auto flex items-center gap-4 px-[50vw] sm:px-[50vw] py-3 scrollbar-hide relative z-20"
          >
            {scenes.map((scene, i) => {
              const isActive = i === activeSceneIndex;
              return (
                <div 
                  key={i} 
                  onClick={() => {
                    if (audioRef.current && duration) {
                      const newTime = Math.min(scene.timestamp, duration - 0.1);
                      audioRef.current.currentTime = newTime;
                      setCurrentTime(newTime);
                    }
                  }}
                  className={`relative group shrink-0 h-full aspect-[9/16] rounded-md overflow-hidden border cursor-pointer transition-all ${
                    isActive 
                    ? 'border-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.4)] ring-2 ring-orange-500 z-10 scale-105' 
                    : 'border-zinc-800 opacity-50 hover:opacity-100 hover:border-zinc-600 scale-95'
                  }`}
                >
                  {scene.imageUrl ? (
                    <img src={scene.imageUrl} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-zinc-900 flex items-center justify-center">
                      {regeneratingIdx === i ? <Loader2 size={12} className="animate-spin text-orange-500" /> : <Loader2 size={12} className="animate-spin text-zinc-600" />}
                    </div>
                  )}
                  <div className="absolute top-0 right-0 bg-black/80 px-1 py-0.5 rounded-bl text-[8px] font-mono text-white">
                    {scene.timestamp.toFixed(0)}s
                  </div>
                  {/* Regenerate Button in top left corner */}
                  <div className={`absolute inset-0 bg-transparent pointer-events-none transition-opacity ${isActive ? 'opacity-100 group-hover:opacity-100' : 'opacity-0 hover:opacity-100 hover:backdrop-blur-[1px]'}`}>
                     <button 
                       disabled={regeneratingIdx === i}
                       onClick={(e) => { e.stopPropagation(); regenerateImage(i); }}
                       className={`absolute top-1 left-1 p-1.5 rounded-md transition-all pointer-events-auto backdrop-blur-md z-20 ${isActive ? 'bg-black/60 hover:bg-orange-500' : 'bg-black/40 hover:bg-white/30'}`}
                       title="Regenerate Frame"
                     >
                       <RefreshCw size={12} className={regeneratingIdx === i ? "animate-spin text-orange-500" : ""} />
                     </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Bottom chat input */}
        <div className="relative w-full">
          {/* Toggle arrow */}
          <div className="absolute left-1/2 bottom-full -translate-x-1/2 z-40 flex flex-col items-center">
             <button 
               onClick={() => setShowInputBar(!showInputBar)} 
               className="bg-zinc-900 border border-zinc-800/80 text-zinc-400 hover:text-white px-4 py-1 rounded-t-xl hover:bg-zinc-800 transition-colors shadow-[0_-4px_10px_rgba(0,0,0,0.3)] flex items-center justify-center opacity-80 hover:opacity-100"
               title={showInputBar ? "Hide Chat" : "Show Chat"}
             >
               {showInputBar ? <ChevronDown size={14} /> : <ChevronLeft size={14} className="rotate-90" />}
             </button>
          </div>

          <AnimatePresence initial={false}>
            {showInputBar && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden bg-zinc-950 border-t border-zinc-800/50 w-full"
              >
                <div className="p-2 sm:p-3 relative z-30">
                  <div className="max-w-3xl mx-auto flex items-end gap-2 bg-zinc-900 rounded-xl p-1 focus-within:ring-1 focus-within:ring-orange-500/50 transition-all shadow-inner border border-zinc-800">
      {showVoiceSelector && (
        <div className="absolute bottom-full left-0 mb-2 w-64 bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden z-50">
          <div className="p-2 border-b border-zinc-800 bg-zinc-900/50">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest pl-1">Select Voice Model</span>
          </div>
          <div className="max-h-60 overflow-y-auto custom-scrollbar">
            {VOICES.map(v => (
              <button
                key={v.id}
                onClick={() => {
                  setSelectedVoice(v.id);
                  setShowVoiceSelector(false);
                }}
                className={`w-full text-left px-4 py-3 text-[12px] flex items-center justify-between transition-colors
                  ${selectedVoice === v.id ? 'bg-orange-500/10 text-orange-500' : 'text-zinc-400 hover:bg-zinc-900 hover:text-white'}`}
              >
                <span>{v.name}</span>
                {selectedVoice === v.id && <Zap size={12} fill="currentColor" />}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setShowVoiceSelector(!showVoiceSelector)}
        className="shrink-0 h-[36px] px-3 flex items-center gap-2 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-lg transition-colors group/voice"
        title="Select Voice Model"
      >
        <Volume2 size={16} className="text-orange-500 group-hover/voice:scale-110 transition-transform" />
        <span className="text-[10px] font-bold uppercase tracking-widest hidden xs:block">{VOICES.find(v => v.id === selectedVoice)?.name.split(' (')[0]}</span>
      </button>
                    <div className="w-px h-6 bg-zinc-800 shrink-0 mb-1.5" />
                    <textarea
                      ref={textareaRef}
                      value={script}
                      onChange={(e) => setScript(e.target.value)}
                      onFocus={() => setIsFocused(true)}
                      onBlur={() => setIsFocused(false)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          generateFullVideo();
                          (e.target as HTMLTextAreaElement).blur();
                        }
                      }}
                      placeholder="Paste script... (Enter to execute)"
                      className="flex-1 bg-transparent border-none text-[13px] text-zinc-200 placeholder:text-zinc-600 outline-none resize-none px-3 py-1.5 min-h-[36px] overflow-y-auto custom-scrollbar leading-relaxed mb-0.5"
                      rows={1}
                    />
                    <button
                      onClick={() => generateFullVideo()}
                      disabled={!script.trim()}
                      className="shrink-0 h-[32px] w-[32px] mb-0.5 bg-orange-500 hover:bg-orange-600 text-black font-bold tracking-wide rounded-md flex items-center justify-center shadow-lg shadow-orange-500/20 transition-all disabled:opacity-30 disabled:scale-100 active:scale-95"
                      title="Generate Project"
                    >
                      {activeJobId ? <Sparkles size={16} /> : <ArrowUp size={16} strokeWidth={3} />}
                    </button>
                  </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>

      {error && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[100] w-[90%] max-w-sm">
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-[11px] backdrop-blur-xl shadow-2xl flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-4 hover:text-white">✕</button>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-zinc-900 border border-zinc-800 w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="flex justify-between items-center p-4 border-b border-zinc-800">
                <h2 className="font-bold text-lg">Settings & Cloud</h2>
                <button onClick={() => setShowSettings(false)} className="text-zinc-500 hover:text-white p-1">
                  ✕
                </button>
              </div>
              <div className="p-6 overflow-y-auto max-h-[70vh] custom-scrollbar">
                {isAuthLoading ? (
                  <div className="flex justify-center p-10"><Loader2 className="animate-spin text-orange-500" size={32} /></div>
                ) : !user ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-4">
                    <div className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center mb-2">
                       <Zap size={24} className="text-orange-500" />
                    </div>
                    <h3 className="text-xl font-bold">Sync your Workspace</h3>
                    <p className="text-zinc-400 text-center text-sm px-4 max-w-sm mb-4">
                      Connect via a GitHub Personal Access Token (Classic) with <strong>repo</strong> and <strong>gist</strong> scopes to securely store everything entirely in your GitHub account.
                    </p>
                    <form onSubmit={handleLoginWithToken} className="flex flex-col gap-3 w-full max-w-xs">
                      <input 
                        type="password"
                        placeholder="ghp_..."
                        value={githubTokenInput}
                        onChange={(e) => setGithubTokenInput(e.target.value)}
                        className="w-full bg-black border border-zinc-800 rounded-lg p-3 text-sm font-mono text-zinc-300 placeholder:text-zinc-700 outline-none focus:border-orange-500 transition-colors"
                      />
                      <button 
                        type="submit"
                        disabled={!githubTokenInput}
                        className="w-full bg-white text-black font-bold px-6 py-3 rounded-xl shadow-lg hover:scale-[1.02] active:scale-95 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                      >
                        <svg height="20" viewBox="0 0 16 16" version="1.1" width="20" aria-hidden="true" fill="currentColor">
                          <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>
                        </svg>
                        Connect via Token
                      </button>
                    </form>
                    <a href="https://github.com/settings/tokens/new?scopes=repo,gist&description=AI%20Studio%20Video%20Editor" target="_blank" rel="noreferrer" className="text-xs text-orange-500 hover:underline">
                      Generate a Token here
                    </a>
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between p-3 bg-zinc-950 rounded-xl border border-zinc-800">
                      <div className="flex items-center gap-3">
                        {user.avatar_url ? (
                          <img src={user.avatar_url} alt="Avatar" className="w-8 h-8 rounded-full border border-zinc-700" />
                        ) : (
                          <div className="w-8 h-8 bg-orange-500/20 text-orange-500 rounded-full flex items-center justify-center font-bold">
                            {user.login?.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div>
                          <div className="text-sm font-bold">{user.name || user.login}</div>
                          <div className="text-xs text-zinc-500">@{user.login}</div>
                        </div>
                      </div>
                      <button onClick={handleLogout} className="text-xs text-zinc-400 hover:text-white bg-zinc-800/50 px-3 py-1.5 rounded-lg">Logout</button>
                    </div>

                    <div className="space-y-4">
                      <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest border-b border-zinc-800 pb-2">API Keys & Workers</h3>
                      
                      <div className="space-y-2">
                        <label className="text-xs text-zinc-500 font-bold uppercase block">Gemini API Keys (comma or line separated)</label>
                        <textarea 
                          value={apiKeysInputText}
                          onChange={(e) => setApiKeysInputText(e.target.value)}
                          className="w-full bg-black border border-zinc-800 rounded-lg p-3 text-sm font-mono text-zinc-300 placeholder:text-zinc-700 outline-none focus:border-orange-500 transition-colors"
                          placeholder="AIzaSy...&#10;AIzaSy..."
                          rows={2}
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-xs text-zinc-500 font-bold uppercase block">Flux Image Worker URLs (comma or line separated)</label>
                        <textarea 
                          value={imageUrlsInputText}
                          onChange={(e) => setImageUrlsInputText(e.target.value)}
                          className="w-full bg-black border border-zinc-800 rounded-lg p-3 text-sm font-mono text-zinc-300 placeholder:text-zinc-700 outline-none focus:border-orange-500 transition-colors"
                          placeholder="https://flux...workers.dev&#10;https://flux..."
                          rows={3}
                        />
                      </div>
                      
                      {saveStatus.message && (
                        <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${saveStatus.type === 'error' ? 'bg-red-500/20 text-red-400' : saveStatus.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-orange-500/20 text-orange-400'}`}>
                           {saveStatus.type === 'saving' && <Loader2 size={14} className="animate-spin" />}
                           {saveStatus.message}
                        </div>
                      )}
                      
                      <button 
                        onClick={() => {
                          setSaveStatus({ type: 'saving', message: 'Saving configuration locally...' });
                          try {
                            const newApiKeys = apiKeysInputText.split(/[,\s\n]+/).map(s => s.trim()).filter(Boolean);
                            const newImageUrls = imageUrlsInputText.split(/[,\s\n]+/).map(s => s.trim()).filter(Boolean);
                            
                            setApiKeys(newApiKeys);
                            setImageUrls(newImageUrls);

                            localStorage.setItem('GEMINI_API_KEYS', JSON.stringify(newApiKeys));
                            if (newImageUrls.length > 0) {
                              localStorage.setItem('IMAGE_WORKER_URLS', newImageUrls.join(','));
                            } else {
                              localStorage.removeItem('IMAGE_WORKER_URLS'); 
                            }
                            
                            setSaveStatus({ type: 'success', message: 'Settings saved securely to your browser (Never sent to GitHub!)' });
                            setTimeout(() => setSaveStatus({ type: 'idle', message: '' }), 5000);
                          } catch(e: any) {
                            if (e.name === 'QuotaExceededError' || e.message?.includes('quota')) {
                               setSaveStatus({ type: 'error', message: 'Browser Storage Full. Please use "Clear Local Cache" below.' });
                            } else {
                               setSaveStatus({ type: 'error', message: 'Save Failed: ' + e.message });
                            }
                          }
                        }}
                        disabled={saveStatus.type === 'saving'}
                        className="w-full bg-orange-500 hover:bg-orange-600 text-black font-bold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                         Save Configuration
                      </button>

                      <div className="pt-4 border-t border-zinc-800 flex flex-col gap-2">
                        <button 
                          onClick={() => {
                            if (confirm("This will clear your local GitHub token. You will need to login again. Continue?")) {
                              localStorage.clear();
                              window.location.reload();
                            }
                          }}
                          className="w-full bg-zinc-900 border border-zinc-800 text-zinc-500 hover:text-red-400 py-2 rounded-lg text-xs transition-colors"
                        >
                          Clear Local Cache
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
