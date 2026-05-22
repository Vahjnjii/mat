import path from "path";
import fs from "fs";
import { GoogleGenAI, Modality } from "@google/genai";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface JobState {
  id: string;
  status: 'idle' | 'generating_voice' | 'planning' | 'generating_images' | 'stitching' | 'uploading' | 'completed' | 'failed';
  script: string;
  audioBase64?: string;
  duration?: number;
  progress: number;
  error?: string;
  scenes: {
    timestamp: number;
    prompt: string;
    text: string;
    imageUrl?: string;
    duration?: number;
  }[];
  videoUrl?: string; // final github url
}

export const activeJobs = new Map<string, JobState>();

const generateWithRetry = async (params: any, keys: string[]) => {
  let attempts = 0;
  let lastError = null;
  for (const key of keys) {
    const client = new GoogleGenAI({ apiKey: key });
    try {
      attempts++;
      const res = await client.models.generateContent(params);
      return res;
    } catch (err: any) {
      lastError = err;
      const msg = (err.message || "").toLowerCase();
      if (msg.includes('quota') || msg.includes('429')) continue;
      // Also fail over for other errors
    }
  }
  throw new Error(`Failed after ${attempts} key(s): ` + lastError);
};

export async function runJob(jobId: string, script: string, apiKey: string[], imageWorkers: string[], githubToken: string, selectedVoice: string) {
  const job: JobState = {
    id: jobId,
    status: 'generating_voice',
    script,
    progress: 5,
    scenes: [],
  };
  activeJobs.set(jobId, job);

  const sessionDir = path.join("tmp", jobId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  try {
    // 1. Generate Voice
    console.log(`[${jobId}] Synthesizing voice...`);
    const ttsResponse = await generateWithRetry({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: script }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice || 'Charon' } },
        },
      },
    }, apiKey);

    const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData?.data;
    if (!base64Audio) throw new Error("Voiceover failed.");
    
    // We get PCM base64 from gemini, we need to convert to WAV to play via FFmpeg and Frontend
    const binary = Buffer.from(base64Audio, 'base64');
    
    const wavBuffer = createWavHeader(binary.length, 24000)
    const audioPath = path.join(sessionDir, "audio.wav");
    fs.writeFileSync(audioPath, Buffer.concat([wavBuffer, binary]));
    
    const audioDuration = binary.length / (24000 * 2);
    job.audioBase64 = Buffer.concat([wavBuffer, binary]).toString('base64');
    job.duration = audioDuration;
    job.status = 'planning';
    job.progress = 15;
    activeJobs.set(jobId, { ...job });

    console.log(`[${jobId}] Planning story... duration: ${audioDuration}s`);
    
    const planResponse = await generateWithRetry({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: script }] }],
      config: {
        systemInstruction: `You are a cinematic video producer. Divide the provided script into chronological segments of roughly 6 seconds each to match the total duration of ${audioDuration.toFixed(1)} seconds.
        For each segment:
        1. "timestamp": start time in seconds.
        2. "prompt": deeply emotional, dark psychological anime style prompt. Unique composition.
        3. "text": exactly matching the script portion.
        Output as a JSON array of objects.`,
        responseMimeType: "application/json",
      }
    }, apiKey);

    let parsedPlan;
    try {
        let text = planResponse.text || "[]";
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) text = jsonMatch[0];
        parsedPlan = JSON.parse(text);
    } catch(e) {
        throw new Error("Failed to parse visual plan JSON.");
    }
    
    const PAUSE_DUR = 0.5, WORD_DUR = 0.3;
    const baseDurations = parsedPlan.map((s:any) => ((s.text || "").split(/\s+/).length * WORD_DUR) + PAUSE_DUR);
    const totalBase = baseDurations.reduce((a:number, b:number) => a + b, 0);
    const scale = audioDuration / (totalBase || 1);
    
    let runningTime = 0;
    job.scenes = parsedPlan.map((s: any, i: number) => {
      const startTime = runningTime;
      const duration = baseDurations[i] * scale;
      runningTime += duration;
      return { ...s, timestamp: startTime, duration, prompt: s.prompt || "cinematic" };
    });
    
    job.status = 'generating_images';
    job.progress = 25;
    activeJobs.set(jobId, { ...job });

    console.log(`[${jobId}] Generating images for ${job.scenes.length} scenes...`);
    
    // Add default workers
    const activeImageWorkers = imageWorkers && imageWorkers.length > 0 ? imageWorkers : [
        "https://flux1.shreevathsa2k27.workers.dev/",
        "https://flux.shreevathsa2k21-4fa.workers.dev/",
        "https://flux.vaishakhaphotos2.workers.dev/"
    ];
    
    for (let i = 0; i < job.scenes.length; i++) {
        const scene = job.scenes[i];
        let workerUrl = activeImageWorkers[i % activeImageWorkers.length];
        const fullPrompt = `Deeply dark psychological anime/manga style, heart-touching human vulnerability, cinematic composition, ${scene.prompt}, masterpiece, high quality, expressive shadows, soulful atmosphere, no text.`;
        
        let success = false;
        
        // 1. Try workers
        for(let attempts = 0; attempts < 3 && !success; attempts++) {
           try {
             workerUrl = activeImageWorkers[(i + attempts) % activeImageWorkers.length];
             const res = await axios.post(workerUrl, 
               { prompt: fullPrompt },
               { responseType: 'arraybuffer', timeout: 30000 }
             );
             
             const imgBufferRaw = Buffer.from(res.data, 'binary');
             let finalImgBuffer = imgBufferRaw;
             
             if (imgBufferRaw[0] === 123) { // 123 is '{'
                const textData = imgBufferRaw.toString('utf-8');
                try {
                  const json = JSON.parse(textData);
                  const b64 = json.image || json.result?.image || json.img;
                  if (b64) {
                    const base64Data = b64.replace(/^data:image\/\w+;base64,/, "");
                    finalImgBuffer = Buffer.from(base64Data, 'base64');
                  } else {
                     throw new Error("JSON response did not contain image generation payload.");
                  }
                } catch(e) {
                  throw new Error("Failed to parse JSON response from image generation API.");
                }
             } else if (imgBufferRaw[0] === 60) { // 60 is '<' for HTML
                 throw new Error("Received HTML error page instead of image.");
             }
             
             if (finalImgBuffer.length < 5000) {
                 throw new Error("Generated image buffer is impossibly small, likely an error.");
             }

             const imgPath = path.join(sessionDir, `img_${i}.jpg`);
             fs.writeFileSync(imgPath, finalImgBuffer);
             
             job.scenes[i].imageUrl = 'data:image/jpeg;base64,' + finalImgBuffer.toString('base64');
             success = true;
           } catch(err: any) {
             console.warn(`[${jobId}] Image ${i} attempt ${attempts} failed on worker ${workerUrl}`);
           }
        }
        
        // 2. Fallback to Pollinations
        if (!success) {
           console.log(`[${jobId}] Attempting Pollinations fallback for scene ${i}`);
           try {
              // Truncate prompt to ~800 chars to avoid 414 URI Too Long
              let polyPrompt = fullPrompt;
              if (polyPrompt.length > 800) polyPrompt = polyPrompt.substring(0, 800) + '...';
              
              const polyRes = await axios.get(`https://image.pollinations.ai/prompt/${encodeURIComponent(polyPrompt)}?width=768&height=1344&nologo=true`, {
                  responseType: 'arraybuffer', timeout: 20000
              });
              
              const imgBuffer = Buffer.from(polyRes.data, 'binary');
              if (imgBuffer[0] === 60) throw new Error("Pollinations returned HTML");
              if (imgBuffer.length < 5000) throw new Error("Pollinations image too small");
              
              const imgPath = path.join(sessionDir, `img_${i}.jpg`);
              fs.writeFileSync(imgPath, imgBuffer);
              job.scenes[i].imageUrl = 'data:image/jpeg;base64,' + imgBuffer.toString('base64');
              success = true;
           } catch(e: any) {
              console.warn(`[${jobId}] Pollinations fallback failed for scene ${i}:`, e.message);
           }
        }

        // 3. Last Resort Fallback Placeholder
        if (!success) {
            console.error(`Failed to generate image ${i}, using basic safe fallback image`);
            try {
              const polyRes = await axios.get(`https://image.pollinations.ai/prompt/cinematic%20anime%20scene%20beautiful%20sky?width=768&height=1344`, {
                 responseType: 'arraybuffer', timeout: 10000
              });
              const imgBuffer = Buffer.from(polyRes.data, 'binary');
              if (imgBuffer[0] === 60) throw new Error("Placeholder HTML");
              fs.writeFileSync(path.join(sessionDir, `img_${i}.jpg`), imgBuffer);
              job.scenes[i].imageUrl = 'data:image/jpeg;base64,' + imgBuffer.toString('base64');
            } catch(e) {
              const blackJpeg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAAIAAgBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
              fs.writeFileSync(path.join(sessionDir, `img_${i}.jpg`), blackJpeg);
              job.scenes[i].imageUrl = 'data:image/jpeg;base64,' + blackJpeg.toString('base64');
            }
        }
        
        job.progress = 25 + (i / job.scenes.length) * 60;
        activeJobs.set(jobId, { ...job });
    }

    job.status = 'completed';
    job.progress = 100;
    activeJobs.set(jobId, { ...job });
    console.log(`[${jobId}] Image generation and audio complete! Ready for canvas rendering.`);
    
    // Cleanup memory after a while, let frontend grab it
    setTimeout(() => {
        activeJobs.delete(jobId);
        fs.rm(sessionDir, { recursive: true, force: true }, () => {});
    }, 20 * 60 * 1000);

  } catch (err: any) {
    console.error(`[${jobId}] Job Failed:`, err);
    job.status = 'failed';
    job.error = err.message || "Unknown error";
    activeJobs.set(jobId, { ...job });
  }
}

async function uploadToGithubRelease(token: string, jobId: string, mp4Path: string, scriptText: string) {
    const octokit = new (await import("@octokit/rest")).Octokit({ auth: token });
    const { data: user } = await octokit.users.getAuthenticated();
    const owner = user.login;
    const repo = "ai-studio-video-projects";

    try {
      await octokit.repos.get({ owner, repo });
    } catch(e: any) {
      if (e.status === 404) {
         await octokit.repos.createForAuthenticatedUser({ name: repo, private: true, auto_init: true });
         await new Promise(r => setTimeout(r, 4000));
      } else {
         throw e;
      }
    }

    // First commit the script to projects/jobId/script.txt so it shows in the sidebar tree
    try {
      let refSha;
      let baseTreeSha;
      try {
        const { data: ref } = await octokit.git.getRef({ owner, repo, ref: 'heads/main' });
        refSha = ref.object.sha;
        const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: refSha });
        baseTreeSha = commit.tree.sha;
      } catch (e: any) {
        // empty repo case
        baseTreeSha = undefined;
      }

      const scriptBase64 = Buffer.from(scriptText).toString('base64');
      const { data: scriptBlob } = await octokit.git.createBlob({ owner, repo, content: scriptBase64, encoding: 'base64' });
      
      const treeData = [
        { path: `projects/${jobId}/script.txt`, mode: '100644' as const, type: 'blob' as const, sha: scriptBlob.sha }
      ];

      const treeParams: any = { owner, repo, tree: treeData };
      if (baseTreeSha) treeParams.base_tree = baseTreeSha;
      
      const { data: newTree } = await octokit.git.createTree(treeParams);
      const commitParams: any = { owner, repo, message: `Add video project ${jobId}`, tree: newTree.sha };
      if (refSha) commitParams.parents = [refSha];
      
      const { data: newCommit } = await octokit.git.createCommit(commitParams);

      if (refSha) {
        await octokit.git.updateRef({ owner, repo, ref: 'heads/main', sha: newCommit.sha });
      } else {
        await octokit.git.createRef({ owner, repo, ref: 'refs/heads/main', sha: newCommit.sha });
      }
    } catch (e) {
      console.error("Failed writing script.txt tree", e);
      // ignoring so we still finish release
    }

    const { data: release } = await octokit.repos.createRelease({
      owner, repo, tag_name: `vid-${jobId}`, name: `Video ${jobId}`,
      body: "Rendered backend MP4", draft: false, prerelease: false
    });

    const fileData = fs.readFileSync(mp4Path);
    const { data: uploadRes } = await axios.post(
      release.upload_url.replace("{?name,label}", `?name=output.mp4`),
      fileData,
      {
        headers: {
          'Authorization': `token ${token}`,
          'Content-Type': 'video/mp4'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );
    return uploadRes.browser_download_url;
}

function createWavHeader(dataLength: number, sampleRate: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); 
  header.writeUInt16LE(1, 20); 
  header.writeUInt16LE(1, 22); 
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); 
  header.writeUInt16LE(2, 32); 
  header.writeUInt16LE(16, 34); 
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}
