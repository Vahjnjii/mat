import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import axios from "axios";
import dotenv from "dotenv";
import { runJob, activeJobs } from "./jobStore";
import sharp from "sharp";

dotenv.config();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);


const upload = multer({ dest: "tmp/" });

// Ensure tmp directory exists
if (!fs.existsSync("tmp")) {
  fs.mkdirSync("tmp");
}

ffmpeg.getAvailableFormats((err) => {
  if (err) {
    console.error("FFMPEG INITIALIZATION ERROR:", err);
  } else {
    console.log("FFMPEG is ready and available.");
  }
});

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  // Middleware
  app.use(express.json({ limit: "200mb" }));
  app.use(express.urlencoded({ limit: "200mb", extended: true }));
  
  // Endpoints for persisting frontend state
  const stateFilePath = path.join("tmp", "app_state.json");
  
  app.get("/api/state", (req, res) => {
    try {
      if (fs.existsSync(stateFilePath)) {
        const data = fs.readFileSync(stateFilePath, "utf-8");
        return res.json(JSON.parse(data));
      }
      res.json({});
    } catch (e) {
      console.error("Reading state failed:", e);
      res.json({});
    }
  });

  app.post("/api/state", (req, res) => {
    try {
      if (!fs.existsSync("tmp")) fs.mkdirSync("tmp");
      fs.writeFileSync(stateFilePath, JSON.stringify(req.body, null, 2));
      res.json({ success: true });
    } catch (e) {
      console.error("Writing state failed:", e);
      res.status(500).json({ error: "Failed to save state" });
    }
  });

  // Create a new Background Generation Job
  app.post("/api/generate", (req, res) => {
    try {
      const { script, apiKeys, imageWorkers, githubToken, voice, repoName } = req.body;
      if (!script) return res.status(400).json({ error: "Missing script" });
      if (!githubToken) return res.status(400).json({ error: "Missing githubToken" });
      if (!apiKeys || apiKeys.length === 0) return res.status(400).json({ error: "Missing Gemini APIs" });

      const jobId = Date.now().toString();
      
      // Kickoff background job
      runJob(jobId, script, apiKeys, imageWorkers, githubToken, voice, repoName || "ai-studio-video-projects").catch(err => {
        console.error("Job runner crashed:", err);
      });

      res.json({ jobId });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get status of a background job
  app.get("/api/job/:jobId", (req, res) => {
    const job = activeJobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found or expired" });
    }
    res.json(job);
  });

  // Convert WebM to MP4 endpoint
  app.post("/api/video/render", upload.single("video"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }
    
    console.log("Received video file to convert:", req.file.path);
    const inputPath = req.file.path;
    const outputPath = path.join("tmp", `${req.file.filename}.mp4`);
    
    // Convert the webm to mp4
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a aac',
        '-b:a 192k',
        '-movflags +faststart'
      ])
      .save(outputPath)
      .on('end', () => {
        console.log("Conversion finished! Sending MP4 back.");
        res.download(outputPath, "final_video.mp4", (err) => {
          if (err) console.error("Error sending file:", err);
          
          // Cleanup
          fs.unlink(inputPath, () => {});
          fs.unlink(outputPath, () => {});
        });
      })
      .on('error', (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: "Conversion failed" });
        // Cleanup
        fs.unlink(inputPath, () => {});
      });
  });

  // Server-side FFmpeg Stitching endpoint
  app.post("/api/video/stitch", async (req, res) => {
    console.log(`Received stitch request with ${req.body?.scenes?.length || 0} scenes.`);
    const { scenes, audioBase64 } = req.body;
    
    if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: "No scenes provided" });
    }

    const sessionId = Date.now().toString();
    const sessionDir = path.join("tmp", sessionId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

    try {
      const imagePaths: string[] = [];
      const concatFilePath = path.join(sessionDir, "concat.txt");
      let concatContent = "";

      // Save audio
      const audioPath = path.join(sessionDir, "audio.wav");
      const audioBuffer = Buffer.from(audioBase64, "base64");
      fs.writeFileSync(audioPath, audioBuffer);

      const srtFilePath = path.join(sessionDir, "subs.srt");
      let srtContent = "";

      const formatSrtTime = (seconds: number) => {
          const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
          const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
          const s = Math.floor(seconds % 60).toString().padStart(2, '0');
          const ms = Math.floor((seconds * 1000) % 1000).toString().padStart(3, '0');
          return `${h}:${m}:${s},${ms}`;
      };

      // Process scenes
      let validScenesCount = 0;
      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const imgPath = path.join(sessionDir, `img_${i}.jpg`);
        
        let rawBuffer: Buffer | null = null;
        if (scene.imageUrl.startsWith("data:")) {
          const baseData = scene.imageUrl.split(",")[1];
          rawBuffer = Buffer.from(baseData, "base64");
        } else if (scene.imageUrl.startsWith("http")) {
          try {
            const response = await axios.get(scene.imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
            rawBuffer = Buffer.from(response.data);
          } catch (dlErr) {
            console.error(`Failed to download image from ${scene.imageUrl}`, dlErr);
            continue; // Skip this scene
          }
        } else {
          console.warn(`Invalid image URL at scene ${i}:`, scene.imageUrl);
          continue; // Skip this scene
        }
        
        // Normalize the image buffer perfectly with sharp!
        try {
           const normalizedBuffer = await sharp(rawBuffer)
               .resize({ width: 768, height: 1344, fit: 'cover' })
               .jpeg({ quality: 90 })
               .toBuffer();
           fs.writeFileSync(imgPath, normalizedBuffer);
        } catch(sharpErr) {
           console.error(`Failed to process image with sharp for scene ${i}:`, sharpErr);
           continue; // Skip
        }
        
        imagePaths.push(imgPath);
        
        // Calculate duration: if it's the last scene, we might need a default or use the total audio length
        // But for now we rely on the duration provided by the client
        concatContent += `file '${path.resolve(imgPath)}'\n`;
        concatContent += `duration ${scene.duration}\n`;

        // Build SRT
        const start = scene.timestamp;
        const end = scene.timestamp + (scene.duration || 5);
        srtContent += `${validScenesCount + 1}\n`;
        srtContent += `${formatSrtTime(start)} --> ${formatSrtTime(end)}\n`;
        srtContent += `${scene.text}\n\n`;
        validScenesCount++;
      }
      
      // FFmpeg quirk: last image needs to be repeated or it might be cut off
      if (imagePaths.length > 0) {
        concatContent += `file '${path.resolve(imagePaths[imagePaths.length - 1])}'\n`;
      }

      fs.writeFileSync(concatFilePath, concatContent);
      fs.writeFileSync(srtFilePath, srtContent);

      const outputPath = path.join(sessionDir, "output.mp4");

      const vfParams = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,subtitles=${path.resolve(srtFilePath).replace(/\\/g, '/').replace(/:/g, '\\\\:')}:force_style='Fontname=Arial,Fontsize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=0,Alignment=2,MarginV=50'`;

      console.log("Starting FFmpeg stitch for session:", sessionId);

      ffmpeg()
        .input(concatFilePath)
        .inputOptions(["-f concat", "-safe 0"])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264',
          '-pix_fmt yuv420p',
          `-vf`, vfParams,
          '-preset fast',
          '-crf 22',
          '-c:a aac',
          '-b:a 192k',
          '-shortest', // Finish when audio ends
          '-movflags +faststart'
        ])
        .save(outputPath)
        .on('end', () => {
          console.log("Stitching finished! Sending MP4 back.");
          res.download(outputPath, "video.mp4", (err) => {
            if (err) console.error("Error sending file:", err);
            
            // Cleanup session directory
            setTimeout(() => {
              fs.rm(sessionDir, { recursive: true, force: true }, () => {});
            }, 10000); // 10s delay to ensure file is sent
          });
        })
        .on('error', (err) => {
          console.error("FFmpeg stitching error:", err);
          res.status(500).json({ error: "Stitching failed: " + err.message });
          fs.rm(sessionDir, { recursive: true, force: true }, () => {});
        });

    } catch (error: any) {
      console.error("Setup error for stitching:", error);
      res.status(500).json({ error: error.message });
      fs.rm(sessionDir, { recursive: true, force: true }, () => {});
    }
  });

  const isProd = process.env.NODE_ENV === "production" || !!process.env.K_SERVICE;
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
