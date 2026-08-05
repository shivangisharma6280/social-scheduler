// Get all activity
// GET /api/activity

import { Response } from "express";
import { AuthRequest } from "../middleware/authMiddleware.js";
import { ActivityLog } from "../models/ActivityLog.js";

export const getActivity = async (req:AuthRequest, res: Response) : Promise<void> => {
    try {
        const activity = await ActivityLog.find({user: req.user._id}).sort({createdAt: -1}).limit(10).populate("relatedPost", "content");
        res.json(activity)
    } catch (error: any) {
        res.status(500).json({message: error?.message || "Server error"});
        
    }
}