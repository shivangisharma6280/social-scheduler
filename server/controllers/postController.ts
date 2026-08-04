import { Response } from "express";
import { AuthRequest } from "../middleware/authMiddleware.js";
import { GoogleGenAI } from "@google/genai";
import { v2 as cloudinary } from "cloudinary";
import { Generation } from "../models/Generation.js";
import { Post } from "../models/Post.js";


// ---------------------------------------------------------------------------
// Cloudinary config
// Requires these in your server/.env:
//   CLOUDINARY_CLOUD_NAME=...
//   CLOUDINARY_API_KEY=...
//   CLOUDINARY_API_SECRET=...
// ---------------------------------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------------------------------------------------------------------
// Helper: build a free image-generation URL using Pollinations.ai
// (no API key, no card required). Cloudinary can fetch this URL directly
// server-side via cloudinary.uploader.upload(tempUrl, ...), so there's no
// need to download the bytes ourselves.
// Docs: https://pollinations.ai
// ---------------------------------------------------------------------------
const buildPollinationsImageUrl = (prompt: string): string => {
  const encodedPrompt = encodeURIComponent(prompt);
  // random seed so repeated identical prompts don't return a cached/identical image
  const seed = Math.floor(Math.random() * 1_000_000);
  return `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true`;
};

// ---------------------------------------------------------------------------
// Generate post
// POST /api/posts/generate
// ---------------------------------------------------------------------------
export const generatePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { prompt, tone, generateImage } = req.body;

    if (!prompt) {
      res.status(400).json({ message: "prompt is required" });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(400).json({
        message: "Gemini api key is missing. Please add it to your server/.env file.",
      });
      return;
    }

    const ai = new GoogleGenAI({ apiKey });

    // ---- 1. Generate text content + image prompt ----
    const textResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Generate a social media post based on this prompt: "${prompt}".
Tone: ${tone}.
Include relevant hashtags.
Respond ONLY with valid JSON with "content" and "imagePrompt" fields, no markdown fences, no preamble.
The "imagePrompt" should be a highly descriptive prompt for an image generator that complements the post.`,
    });

    let content = "";
    let imagePrompt = prompt;

    try {
      const rawText = textResponse.text || "";
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const data = jsonMatch ? JSON.parse(jsonMatch[0]) : { content: rawText, imagePrompt: prompt };
      content = data.content || rawText;
      imagePrompt = data.imagePrompt || prompt;
    } catch (parseErr) {
      console.error("Failed to parse Gemini JSON response:", parseErr);
      content = textResponse.text || "";
    }

    // ---- 2. Optionally generate an image ----
    let mediaUrl = "";

    if (generateImage) {
      try {
        const tempUrl = buildPollinationsImageUrl(imagePrompt);

        // Upload to Cloudinary for persistence
        const uploadResult = await cloudinary.uploader.upload(tempUrl, {
          folder: "ai-generations",
        });
        mediaUrl = uploadResult.secure_url;
      } catch (err: any) {
        console.error("Image generation failed:", err);
      }
    }

    // ---- 3. Save generation to DB ----
    const generation = await Generation.create({
      user: req.user._id,
      prompt,
      content,
      mediaUrl,
      mediatype: mediaUrl ? "image" : undefined,
      tone,
    });

    res.json(generation);
  } catch (error: any) {
    console.error("generatePost error:", error?.response?.data || error?.message || error);
    res.status(500).json({ message: "Failed to generate post", error: error?.message });
  }
};


// Get generations
// GET /api/posts/generations
export const getGenerations = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
     const generations = await Generation.find({user: req.user._id}).sort({createdAt: -1})
     res.json(generations)
  } catch (error: any) {
    res.status(500).json({ message: error?.message || "Server error" });
    
  }
};

// Get posts
// GET /api/posts
export const getPosts = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const posts = await Post.find({user: req.user._id})
        res.json(posts)
    } catch (error: any) {
        res.status(500).json({ message: error?.message || "Server error" });
        
    }
  
};

// Schedule posts
// POST /api/posts
export const schedulePost = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { content, platforms, scheduledFor, status } = req.body;

        //Parse platforms if it comes as a stringified array from data
        let parsedPlatforms = platforms;
        if(typeof platforms === 'string'){
            try {
                parsedPlatforms = JSON.parse(platforms)
            } catch (e) {
                parsedPlatforms = platforms.split(",");

                
            }
        }
        let mediaUrl : string | undefined = req.body.mediaUrl;
        let mediaType : "image" | "video" | undefined = req.body.mediaType;
        
        if(req.file){
          const result = await new Promise<any>((resolve, reject)=>{
            const stream = cloudinary.uploader.upload_stream({resource_type: "auto", folder:"social-scheduler"},(error, result)=>{
              if(error) reject(error);
              else resolve(result)
            });
            stream.end(req.file!.buffer);
          });
          mediaUrl = result.secure_url;
          mediaType = result.resource_type === "video" ? "video" : "image";
        }

        const post = await Post.create({
          user: req.user._id,
          content,
          platforms: parsedPlatforms,
          mediaUrl,
          mediaType,
          scheduledFor,
          status,
        })
        res.status(201).json(post)
        
        
    } catch (error: any) {
        res.status(500).json({ message: error?.message || "Server error" });
        
    }
};
